import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const text=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('package only the exact runtime adapter sources, not voice artifacts',()=>{
  const docker=text('Dockerfile'), context=text('.dockerignore').split(/\r?\n/);
  for(const script of ['render-radio-dynamic.py','radio_voicevox_capi.py']){
    assert(context.includes('!scripts/'+script));
    assert(docker.split(/\r?\n/).some(s=>s.startsWith('COPY ')&&s.includes('scripts/'+script)));
  }
  assert(!context.includes('!scripts/**'));
  assert(!docker.split(/\r?\n/).filter(s=>s.startsWith('COPY ')).some(s=>/\.vvm|\.dll|\.so|\.cer|radio-voice\b/i.test(s)));
});
test('failed renderer startup cannot keep the dynamic feature enabled',()=>{
  const app=text('server/app.js'), renderer=text('server/radio-dynamic-render.js');
  assert.match(renderer,/await runVoice\(config,\['-E','-s','-B',cli,'--probe',job\],undefined,18_000\)/);
  assert.match(app,/catch\{app\.log\.warn\('Local radio renderer unavailable; static audio fallback'\);\}/);
  assert.match(app,/const dynamicEnabled=dynamicRequested&&typeof dynamicRenderer==='function';/);
});

test('Linux voice jobs use the shipped network-denying launcher and no model is required in standard CI',()=>{
  const renderer=text('server/radio-dynamic-render.js'), ci=text('.github/workflows/verify.yml');
  assert.match(renderer,/runAiProcess\(config\.python,args,\{signal,timeout,maxOutput:256\*1024,env:\{LD_LIBRARY_PATH:''\}\}\)/);
  assert.match(renderer,/process\.platform==='linux'&&raw\.python!=='\/usr\/bin\/python3'/);
  assert.match(ci,/node --input-type=module < scripts\/check-radio-voicevox-container\.mjs/);
});
