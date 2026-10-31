import { describe, expect, it } from 'vitest';
import { validateZImageRequest } from './validation';
import { BodyTooLarge, readMediaBody } from './bounded-body';
describe('GPU image route boundaries', () => {
  it('accepts fixed image sizes', () => {
    for (const [width,height] of [[1024,1024],[1280,720],[720,1280]]) {
      expect(validateZImageRequest({kind:'image',prompt:'A cup',params:{width,height}})).toBeNull();
    }
  });
  it.each([{width:8192},{width:true},{seed:-1},{steps:100},{model:'arbitrary'},{negativePrompt:'x'}])('rejects unsupported resources %j', (params) => {
    expect(validateZImageRequest({kind:'image',prompt:'A cup',params})).not.toBeNull();
  });
  it('rejects video and negative prompts', () => {
    expect(validateZImageRequest({kind:'video',prompt:'A cup'})).not.toBeNull();
    expect(validateZImageRequest({kind:'image',prompt:'A cup',negativePrompt:'x'})).not.toBeNull();
  });
  it('reads bounded JSON', async () => {
    expect(await readMediaBody(new Request('http://localhost',{method:'POST',body:'{"prompt":"cup"}'}))).toEqual({prompt:'cup'});
  });
  it('rejects oversized bodies without trusting content-length', async () => {
    await expect(readMediaBody(new Request('http://localhost',{method:'POST',body:'x'.repeat(8193),headers:{'content-length':'1'}}))).rejects.toBeInstanceOf(BodyTooLarge);
  });
});
