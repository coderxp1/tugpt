import type { PublicModel } from '@/components/chat/types';

/** Presentation boundary only. Backend owns routing and must replace legacy model keys with opaque capability IDs. */
export function customerModels(models: readonly PublicModel[]): PublicModel[] {
  return models.filter((m) => models.length === 1 || ['standard', 'advanced', 'fast'].includes(m.experience ?? '')).map((m) => ({
    key: m.key,
    label: m.experience === 'standard' ? 'Standard' : m.experience === 'advanced' ? 'Advanced' : m.experience === 'fast' ? 'Fast' : 'TuGPT Assistant',
    description: '', private: false, toolCalling: m.toolCalling,
    experience: m.experience, available: m.available !== false,
  }));
}
