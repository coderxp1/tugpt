/**
 * @file draft-worker.ts
 * @description Draft generation worker: polls the draft_generation PGMQ queue,
 * verifies feature flag, loads job context, reserves quota, calls the
 * DraftOrchestrator, stores the draft, and handles retry/archive/skip.
 *
 * Never sends outbound WhatsApp messages. Drafts are stored for human review.
 *
 * Content privacy: source message text, prompts, business instructions,
 * draft body, provider response body, phone identifiers, authorization
 * headers, and provider credentials are NEVER logged. Only sanitized
 * metadata is logged: requestId, draftGenerationJobId, provider name,
 * model, normalized error category, latency, attempt number.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@tugpt/observability';
import { DraftPgmqAdapter } from './draft-queue-adapter.js';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';
import {
  selectKnowledgeEntries,
  type KnowledgeEntryRow,
} from './knowledge-selection';
import type { DraftRequest, DraftConfig, DraftResult } from '@tugpt/ai-orchestration';
import { DEFAULT_ORGANIZATION_LOCALE, normalizeOrganizationLocale } from '@tugpt/database';
import type { ProviderErrorCategory } from '@tugpt/ai-providers';
import {
  mapProviderErrorToDbCode,
  isTransientCategory,
  type DraftErrorCode,
  type DraftSkipReason,
} from './draft-rpc-error-codes.js';

/** Retry visibility delays per Paul's amendment #7. */
const RETRY_DELAY_1 = 5;   // read_ct = 1 failure → 5 seconds
const RETRY_DELAY_2 = 15;  // read_ct = 2 failure → 15 seconds
// read_ct = 3 failure → archive immediately with DRAFT_EXHAUSTED_RETRIES

const logger = new Logger({ service: 'draft-worker' });

export interface DraftWorkerConfig {
  pollIntervalMs: number;
  visibilityTimeoutSeconds: number;
}

/**
 * Factory function that lazily constructs the DraftOrchestrator.
 * Called only when the worker reaches the provider-generation path
 * (feature flag enabled). This allows the worker to start and poll
 * safely without any provider credentials while ai_draft_generation
 * is disabled.
 */
export type OrchestratorFactory = () => DraftOrchestrator;

export class DraftWorker {
  private client: SupabaseClient;
  private queue: DraftPgmqAdapter;
  private orchestratorOrFactory: DraftOrchestrator | OrchestratorFactory;
  private orchestratorInstance: DraftOrchestrator | null = null;
  private pollIntervalMs: number;
  private visibilityTimeoutSeconds: number;

  constructor(
    client: SupabaseClient,
    orchestratorOrFactory: DraftOrchestrator | OrchestratorFactory,
    config: DraftWorkerConfig
  ) {
    this.client = client;
    this.queue = new DraftPgmqAdapter(client);
    this.orchestratorOrFactory = orchestratorOrFactory;
    this.pollIntervalMs = config.pollIntervalMs;
    this.visibilityTimeoutSeconds = config.visibilityTimeoutSeconds;
  }

  /**
   * Lazily construct or return the orchestrator.
   * If a factory was provided, it is called on first access.
   * If the factory throws (missing provider configuration), the
   * caller must catch and archive the job with DRAFT_PROVIDER_CONFIG_ERROR.
   */
  private getOrchestrator(): DraftOrchestrator {
    if (this.orchestratorInstance) {
      return this.orchestratorInstance;
    }
    if (typeof this.orchestratorOrFactory === 'function') {
      this.orchestratorInstance = this.orchestratorOrFactory();
    } else {
      this.orchestratorInstance = this.orchestratorOrFactory;
    }
    return this.orchestratorInstance;
  }

  /**
   * Main poll loop. Runs until the abort signal fires.
   */
  async run(signal: AbortSignal): Promise<void> {
    logger.info('Draft worker started', {});

    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error('Draft worker poll error', err as Error, {});
      }

      await this.sleep(this.pollIntervalMs, signal);
    }

    logger.info('Draft worker shutting down', {});
  }

  /**
   * Process one batch of queue messages.
   */
  private async pollOnce(): Promise<void> {
    const jobs = await this.queue.readJobs(1, this.visibilityTimeoutSeconds);

    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      await this.processJob(job);
    }
  }

  /**
   * Process a single draft generation job.
   */
  private async processJob(job: {
    msgId: bigint;
    readCt: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const { msgId, readCt, payload } = job;

    // Extract metadata-only fields from payload
    const draftGenerationJobId = payload.draftGenerationJobId as string;
    const requestId = (payload.requestId as string | null) ?? undefined;

    if (!draftGenerationJobId) {
      // Malformed queue payload: archive immediately
      logger.error('Malformed queue payload: missing draftGenerationJobId', undefined, {
        queueMessageId: msgId.toString(),
      });
      await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_REQUEST');
      return;
    }

    // Log only sanitized metadata
    logger.info('Processing draft job', {
      draftGenerationJobId,
      requestId,
      attempt: readCt,
    });

    try {
      // Step 1: Load job row from database
      const jobRow = await this.loadJob(draftGenerationJobId);
      if (!jobRow) {
        logger.error('Draft job not found in database', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_REQUEST');
        return;
      }

      // Step 2: Verify feature flag
      const flagEnabled = await this.checkFeatureFlag(jobRow.organization_id);
      if (!flagEnabled) {
        logger.info('Feature flag disabled, skipping draft job', {
          draftGenerationJobId,
          requestId,
        });
        await this.skipJob(draftGenerationJobId, msgId, 'FEATURE_DISABLED');
        return;
      }

      // Step 2b: Lazily construct orchestrator (only when feature is enabled).
      // If provider configuration is missing, the factory throws and we
      // archive through the approved config-error path.
      // Credential values are never logged.
      let orchestrator: DraftOrchestrator;
      try {
        orchestrator = this.getOrchestrator();
      } catch {
        logger.info('Provider configuration error, archiving draft job', {
          draftGenerationJobId,
          requestId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_PROVIDER_CONFIG_ERROR');
        return;
      }

      // Step 3: Load source message
      const sourceText = await this.loadSourceMessage(jobRow.source_message_id, jobRow.organization_id);
      if (!sourceText) {
        logger.error('Source message not found', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_REQUEST');
        return;
      }

      // Step 4: Load ai_draft_config
      const baseConfig = await this.loadDraftConfig(jobRow.business_profile_id, jobRow.organization_id);
      if (!baseConfig) {
        logger.error('Draft config not found', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_CONFIG');
        return;
      }

      // Step 4b (FAQ v1): select this organization's knowledge
      // entries relevant to the customer's message. Never fails the
      // draft: no entries (or a read error) leaves the config
      // exactly as it was before FAQ existed.
      const knowledgeEntries = await this.loadKnowledgeEntries(
        jobRow.organization_id,
        sourceText
      );
      const config: DraftConfig =
        knowledgeEntries.length > 0
          ? { ...baseConfig, knowledgeEntries }
          : baseConfig;

      // Step 5: Reserve quota
      const reservation = await this.reserveQuota(draftGenerationJobId);
      if (reservation.status === 'DENIED') {
        logger.info('Quota denied, skipping draft job', {
          draftGenerationJobId,
          requestId,
          reason: reservation.reason,
        });
        // Quota denial is an entitlement outcome, not a provider failure.
        // Terminate through the skip/denial path.
        await this.skipJob(draftGenerationJobId, msgId, 'QUOTA_DENIED');
        return;
      }

      // reserve_draft_usage has five outcomes, and two of them mean this job
      // is already finished:
      //
      //   ALREADY_CONSUMED     store_draft ran; a draft exists for this job.
      //   RESERVATION_RELEASED the job was archived; it is dead-lettered.
      //
      // Either way the queue message is stale — it outlived the job. That
      // happens when store_draft succeeds and queue.deleteJob does not: a
      // dropped connection does it, and so does SIGKILL at the end of
      // stop_grace_period, which is what this worker gets on a deploy while a
      // job is in flight.
      //
      // Falling through here used to be unbounded. The provider was called
      // again (real spend), store_draft then raised P3B10, the catch archived
      // it, the archive raised P3B12 because the job was already completed,
      // the DRAFT_INTERNAL_ERROR fallback raised P3B12 as well — the status
      // check sits above the error-code allowlist — and the message was left
      // on the queue to be redelivered and do it all again. One provider call
      // per lap, forever.
      //
      // ALREADY_RESERVED deliberately does NOT terminate: that is the ordinary
      // retry, where a previous attempt reserved quota and failed before
      // storing anything, and it should generate.
      if (
        reservation.status === 'ALREADY_CONSUMED' ||
        reservation.status === 'RESERVATION_RELEASED'
      ) {
        logger.info('Draft job already terminal; discarding stale queue message', {
          draftGenerationJobId,
          requestId,
          reservationStatus: reservation.status,
          attempt: readCt,
        });
        await this.queue.deleteJob(msgId);
        return;
      }

      // Step 6: Call orchestrator
      const draftRequest: DraftRequest = {
        sourceMessageText: sourceText,
        config,
        organizationId: jobRow.organization_id,
        requestId: requestId || draftGenerationJobId,
      };

      const result = await orchestrator.generateDraft(draftRequest);

      if (result.success) {
        // Step 7: Store draft
        await this.storeDraft(
          draftGenerationJobId,
          jobRow.business_profile_id,
          jobRow.conversation_id,
          jobRow.source_message_id,
          result.result.text,
          result.result.provider,
          result.result.model
        );

        // Step 8: Record what the call consumed and what it cost.
        //
        // After storeDraft, not before: the draft is the customer-visible work
        // and must not be undone by a bookkeeping failure. That ordering is
        // also why recordUsage swallows its own errors — see the comment there
        // for the trade and its named successor.
        await this.recordUsage(
          jobRow.organization_id,
          draftGenerationJobId,
          jobRow.source_message_id,
          requestId,
          result.result
        );

        // Step 9: Delete queue message
        await this.queue.deleteJob(msgId);

        logger.info('Draft generated successfully', {
          draftGenerationJobId,
          requestId,
          provider: result.result.provider,
          model: result.result.model,
          latencyMs: result.result.latencyMs,
          attempt: readCt,
        });
      } else {
        // Provider failure
        await this.handleProviderFailure(
          msgId,
          draftGenerationJobId,
          requestId,
          readCt,
          result.error.category,
          result.error.providerDetail
        );
      }
    } catch (err) {
      // Unexpected error: treat as transient if readCt < 3, else archive
      logger.error('Draft job processing error', err as Error, {
        draftGenerationJobId,
        requestId,
        attempt: readCt,
      });

      if (readCt < 3) {
        const delay = readCt === 1 ? RETRY_DELAY_1 : RETRY_DELAY_2;
        await this.queue.setVisibility(msgId, delay);
      } else {
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_EXHAUSTED_RETRIES');
      }
    }
  }

  /**
   * Handle a provider failure: retry or archive based on attempt count.
   *
   * Per amendment #7: archive immediately after the third provider failure.
   * read_ct = 1 → visibility delay 5s
   * read_ct = 2 → visibility delay 15s
   * read_ct = 3 → archive immediately with DRAFT_EXHAUSTED_RETRIES
   */
  private async handleProviderFailure(
    msgId: bigint,
    draftGenerationJobId: string,
    requestId: string | undefined,
    readCt: number,
    errorCategory: ProviderErrorCategory,
    providerDetail?: string
  ): Promise<void> {
    const isTransient = isTransientCategory(errorCategory);

    // providerDetail is already sanitized and truncated by ProviderError.
    // Logging it is what makes a provider-side rejection (e.g. an invalid
    // model) diagnosable from the logs alone, without reproducing the call
    // against the live API by hand.
    logger.info('Provider failure', {
      draftGenerationJobId,
      requestId,
      attempt: readCt,
      errorCategory,
      isTransient,
      providerDetail,
    });

    if (isTransient && readCt < 3) {
      // Transient failure, attempts remaining: retry via visibility timeout.
      // Do NOT insert failed_jobs. Do NOT archive.
      const delay = readCt === 1 ? RETRY_DELAY_1 : RETRY_DELAY_2;
      await this.queue.setVisibility(msgId, delay);
    } else if (isTransient && readCt >= 3) {
      // Third transient failure: retries exhausted, archive immediately.
      // The only approved code for exhausted transient retries.
      await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_EXHAUSTED_RETRIES', providerDetail);
    } else {
      // Permanent failure (fallback-prohibited): archive immediately
      // with the mapped approved error code. No retries — a 4xx request
      // error will fail identically every time.
      const archiveCode = mapProviderErrorToDbCode(errorCategory);
      await this.archiveFailed(msgId, draftGenerationJobId, archiveCode, providerDetail);
    }
  }

  // --- Database helper methods ---

  private async loadJob(jobId: string): Promise<{
    organization_id: string;
    conversation_id: string;
    source_message_id: string;
    business_profile_id: string;
  } | null> {
    const { data, error } = await this.client
      .from('draft_generation_jobs')
      .select('organization_id, conversation_id, source_message_id, business_profile_id')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      return null;
    }
    return data;
  }

  private async checkFeatureFlag(organizationId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('is_feature_enabled', {
      p_organization_id: organizationId,
      p_flag_key: 'ai_draft_generation',
    });

    if (error || data === null) {
      return false;
    }
    return data as boolean;
  }

  private async loadSourceMessage(messageId: string, organizationId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('body')
      .eq('id', messageId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) {
      return null;
    }
    return data.body;
  }

  /**
   * FAQ v1: the organization's enabled knowledge entries relevant
   * to this message (knowledge-selection.ts does the scoring; this
   * method only reads). Runs under the worker's service-role
   * client; the organization comes from the job row, never from
   * message content. Any failure returns [] — a knowledge outage
   * degrades drafts to their pre-FAQ behavior, never to an error.
   */
  private async loadKnowledgeEntries(
    organizationId: string,
    sourceText: string
  ): Promise<KnowledgeEntryRow[]> {
    try {
      const { data, error } = await this.client
        .from('knowledge_entries')
        .select('question, answer')
        .eq('organization_id', organizationId)
        .eq('enabled', true)
        .limit(200);

      if (error || !data) {
        return [];
      }
      return selectKnowledgeEntries(
        data as KnowledgeEntryRow[],
        sourceText
      );
    } catch {
      return [];
    }
  }

  private async loadDraftConfig(businessProfileId: string, organizationId: string): Promise<DraftConfig | null> {
    const { data, error } = await this.client
      .from('ai_draft_configs')
      .select('business_instructions, personality, response_rules, tone, max_draft_length')
      .eq('business_profile_id', businessProfileId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) {
      return null;
    }
    return {
      businessInstructions: data.business_instructions,
      personality: data.personality,
      responseRules: data.response_rules,
      tone: data.tone,
      maxDraftLength: data.max_draft_length,
      locale: await this.loadOrganizationLocale(organizationId),
    };
  }

  /**
   * The organization's dashboard language, which is also its prompt language.
   *
   * A second query rather than a join. `ai_draft_configs` has no foreign key to
   * `organizations` that PostgREST would embed, and one more round trip on a
   * path that is about to spend seconds inside a provider call is not worth
   * arranging one for.
   *
   * Never throws, and never returns null. A draft is not worth failing over a
   * language lookup: Spanish is the product default and a complete, correct
   * prompt for every organization that exists. The cost of guessing wrong is a
   * prompt in the wrong language, which the guardrail's "reply in the
   * customer's language" rule largely absorbs; the cost of throwing is a
   * dead-lettered job.
   */
  private async loadOrganizationLocale(organizationId: string): Promise<string> {
    const { data, error } = await this.client
      .from('organizations')
      .select('locale')
      .eq('id', organizationId)
      .single();

    if (error || !data) {
      return DEFAULT_ORGANIZATION_LOCALE;
    }
    return normalizeOrganizationLocale(data.locale);
  }

  private async reserveQuota(jobId: string): Promise<{ status: string; reason: string | null }> {
    const { data, error } = await this.client.rpc('reserve_draft_usage', {
      p_draft_generation_job_id: jobId,
    });

    if (error) {
      return { status: 'DENIED', reason: 'RPC_ERROR' };
    }

    const result = data as { status: string; reason: string | null };
    return { status: result.status, reason: result.reason };
  }

  /**
   * Records one provider call against the organization's cost meter.
   *
   * Deliberately does not throw. By the time this runs the draft is stored and
   * the provider has already charged for the call; failing the job here would
   * retry a draft that already exists, which is a worse outcome than a missing
   * accounting row. So a failure is logged at error level WITH THE QUANTITIES,
   * so the number is recoverable from the logs rather than simply gone.
   *
   * The honest limitation: this is a second transaction, so a crash between
   * storeDraft and here loses the usage. Making it atomic means folding the
   * usage arguments into the store RPC — a real option, deliberately not taken
   * in this change because it couples two things that are otherwise
   * independent, and the loss window is one RPC wide.
   */
  private async recordUsage(
    organizationId: string,
    draftGenerationJobId: string,
    sourceMessageId: string,
    requestId: string | undefined,
    result: DraftResult
  ): Promise<void> {
    // Inside the try, not above it. Reading result.usage is itself a place this
    // can throw — a provider returning a response without a usage block would
    // otherwise take down a draft job that had already succeeded, which is the
    // exact outcome this method exists to avoid. Found by the lifecycle test,
    // whose fixture had no usage block.
    try {
      const quantities = {
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
      };

      const { error } = await this.client.rpc('record_provider_usage', {
        p_organization_id: organizationId,
        p_modality: 'text',
        p_provider: result.provider,
        p_model: result.model,
        p_quantities: quantities,
        p_provider_reference: result.providerReference,
        p_request_id: requestId ?? draftGenerationJobId,
        p_draft_generation_job_id: draftGenerationJobId,
        p_message_id: sourceMessageId,
        p_metadata: { latency_ms: result.latencyMs },
      });

      if (error) {
        throw new Error(error.message);
      }
    } catch (err) {
      logger.error(
        'Failed to record provider usage; the draft is unaffected',
        err instanceof Error ? err : new Error(String(err)),
        {
          draftGenerationJobId,
          requestId,
          provider: result.provider,
          model: result.model,
          // The quantities are logged so the cost is reconstructible by hand.
          // A row we could not write is recoverable; a number we never printed
          // is not.
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        }
      );
    }
  }

  private async storeDraft(
    jobId: string,
    businessProfileId: string,
    conversationId: string,
    sourceMessageId: string,
    body: string,
    provider: string,
    model: string
  ): Promise<void> {
    const { error } = await this.client.rpc('store_draft', {
      p_draft_generation_job_id: jobId,
      p_business_profile_id: businessProfileId,
      p_conversation_id: conversationId,
      p_source_message_id: sourceMessageId,
      p_body: body,
      p_provider: provider,
      p_model: model,
    });

    if (error) {
      throw new Error(`store_draft RPC failed: ${error.code || 'UNKNOWN'}`);
    }
  }

  /**
   * Archive (dead-letter) a job, terminating it.
   *
   * A failed archive must never be swallowed. Before 2026-08-19 it was: the
   * RPC's own error-code allowlist was narrower than the set the worker
   * produced, so every terminal archive was rejected with P3B15, logged, and
   * dropped. The queue message was then neither archived nor deleted, so it
   * was redelivered until read_ct exceeded the limit and the read-side path
   * dead-lettered it as DRAFT_EXHAUSTED_RETRIES — which is how a Langdock 400
   * came to look like three exhausted retries with no provider error recorded.
   *
   * The allowlists are aligned again (migration 20260819000001), but a silent
   * swallow is the wrong behaviour regardless of which codes are legal. If the
   * archive is rejected we retry once with DRAFT_INTERNAL_ERROR — permanently
   * in the RPC's allowlist — so the job always reaches a terminal state
   * instead of looping. Any drift shows up as a loud log, not an invisible
   * retry storm.
   */
  private async archiveFailed(
    msgId: bigint,
    jobId: string,
    errorCode: DraftErrorCode,
    providerDetail?: string
  ): Promise<void> {
    const { error } = await this.client.rpc('archive_draft_failed_job', {
      p_msg_id: msgId.toString(),
      p_draft_generation_job_id: jobId,
      p_error_code: errorCode,
      p_provider_error_detail: providerDetail ?? null,
    });

    if (!error) {
      return;
    }

    logger.error('Failed to archive draft job', new Error(error.code || 'UNKNOWN'), {
      draftGenerationJobId: jobId,
      queueMessageId: msgId.toString(),
      attemptedErrorCode: errorCode,
    });

    // P3B12 says the job is already completed or skipped. There is nothing to
    // archive, and the DRAFT_INTERNAL_ERROR fallback cannot help: the RPC
    // checks the job status before it checks the error code, so the retry
    // raises P3B12 too. What is left is a stale queue message, and leaving it
    // queued means it is redelivered indefinitely — which is the loop this
    // whole path exists to prevent. Delete it.
    if (error.code === 'P3B12') {
      logger.info('Archive refused: job already terminal. Discarding stale queue message', {
        draftGenerationJobId: jobId,
        queueMessageId: msgId.toString(),
        attemptedErrorCode: errorCode,
      });
      await this.queue.deleteJob(msgId);
      return;
    }

    if (errorCode === 'DRAFT_INTERNAL_ERROR') {
      // The guaranteed-accepted code was itself rejected. Nothing further to
      // try; leaving the message queued is preferable to losing it silently.
      logger.error('Archive fallback also failed; job left on the queue', undefined, {
        draftGenerationJobId: jobId,
        queueMessageId: msgId.toString(),
      });
      return;
    }

    const { error: fallbackError } = await this.client.rpc('archive_draft_failed_job', {
      p_msg_id: msgId.toString(),
      p_draft_generation_job_id: jobId,
      p_error_code: 'DRAFT_INTERNAL_ERROR',
      p_provider_error_detail: providerDetail ?? `archive rejected for ${errorCode}`,
    });

    if (fallbackError) {
      logger.error('Archive fallback also failed; job left on the queue', new Error(fallbackError.code || 'UNKNOWN'), {
        draftGenerationJobId: jobId,
        queueMessageId: msgId.toString(),
      });
    } else {
      logger.info('Archived via DRAFT_INTERNAL_ERROR fallback after archive rejection', {
        draftGenerationJobId: jobId,
        attemptedErrorCode: errorCode,
      });
    }
  }

  private async skipJob(jobId: string, msgId: bigint, reason: DraftSkipReason): Promise<void> {
    const { error } = await this.client.rpc('skip_draft_job', {
      p_draft_generation_job_id: jobId,
      p_msg_id: msgId.toString(),
      p_skip_reason: reason,
    });

    if (error) {
      logger.error('Failed to skip draft job', new Error(error.code || 'UNKNOWN'), {
        draftGenerationJobId: jobId,
      });
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
