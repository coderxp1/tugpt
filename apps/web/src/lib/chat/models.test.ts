import { describe, expect, it } from 'vitest';
import { configuredModels, endpointFor, findModel, parseEndpointUrl, publicModels } from './models';
import { parseToolCallList } from './openai-compatible';

describe('parseEndpointUrl', () => {
  it('accepts https anywhere and http only on loopback', () => {
    expect(parseEndpointUrl('http://127.0.0.1:12435/v1')).toBe('http://127.0.0.1:12435/v1');
    expect(parseEndpointUrl('https://llm.example.com/v1/')).toBe('https://llm.example.com/v1');
    expect(parseEndpointUrl('http://10.0.0.5:11434/v1')).toBeNull();
    expect(parseEndpointUrl('http://user:pw@127.0.0.1/v1')).toBeNull();
    expect(parseEndpointUrl('https://x.example.com/v1?key=1')).toBeNull();
    expect(parseEndpointUrl('not a url')).toBeNull();
  });
});

describe('configuredModels', () => {
  it('offers nothing when nothing is configured', () => {
    expect(configuredModels({})).toEqual([]);
  });
  it('offers the private model only with a valid endpoint', () => {
    expect(configuredModels({ TUGPT_PRIVATE_LLM_URL: 'http://192.168.1.2/v1' })).toEqual([]);
    const [m] = configuredModels({ TUGPT_PRIVATE_LLM_URL: 'http://127.0.0.1:12435/v1' });
    expect(m).toMatchObject({ key: 'tugpt-scout', private: true, toolCalling: true, upstreamModel: 'tugpt-scout:latest' });
  });
  it('never exposes endpoints or keys to the browser', () => {
    const env = { TUGPT_PRIVATE_LLM_URL: 'http://127.0.0.1:12435/v1', TUGPT_PRIVATE_LLM_KEY: 'k-private', LANGDOCK_API_KEY: 'k-langdock' };
    const json = JSON.stringify(publicModels(configuredModels(env)));
    expect(json).not.toContain('k-private');
    expect(json).not.toContain('k-langdock');
    expect(json).not.toContain('127.0.0.1');
    expect(json).not.toContain('upstreamModel');
  });
  it('resolves endpoints and rejects unknown keys', () => {
    const env = { TUGPT_PRIVATE_LLM_URL: 'http://127.0.0.1:12435/v1' };
    const models = configuredModels(env);
    expect(endpointFor(models[0], env)).toEqual({ baseUrl: 'http://127.0.0.1:12435/v1', apiKey: null });
    expect(findModel(models, 'gpt-evil')).toBeNull();
    expect(findModel(models, 42)).toBeNull();
  });
});

describe('parseToolCallList', () => {
  const offered = new Set(['calendar_find_availability']);
  it('keeps offered calls with object arguments (string or object form)', () => {
    const out = parseToolCallList([
      { id: 'a', function: { name: 'calendar_find_availability', arguments: '{"timeMin":"x"}' } },
      { id: 'b', function: { name: 'calendar_find_availability', arguments: { timeMin: 'y' } } },
    ], offered);
    expect(out.map((c) => c.arguments)).toEqual([{ timeMin: 'x' }, { timeMin: 'y' }]);
  });
  it('drops calls to tools that were not offered, malformed JSON, arrays and oversized arguments', () => {
    expect(parseToolCallList([
      { id: 'a', function: { name: 'send_email', arguments: '{}' } },
      { id: 'b', function: { name: 'calendar_find_availability', arguments: '{nope' } },
      { id: 'c', function: { name: 'calendar_find_availability', arguments: '[1,2]' } },
      { id: 'd', function: { name: 'calendar_find_availability', arguments: JSON.stringify({ x: 'y'.repeat(20000) }) } },
    ], offered)).toEqual([]);
    expect(parseToolCallList('nope', offered)).toEqual([]);
  });
});
