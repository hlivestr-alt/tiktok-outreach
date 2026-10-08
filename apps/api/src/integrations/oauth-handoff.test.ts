import {describe,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {signHandoff,verifyHandoff,REGISTER_PATH,COMPLETE_PATH,opaque,operatorOrigin,browserCookie,NATIVE_COOKIE,routerOrigin} from './oauth-handoff';
describe('native OAuth private boundary',()=>{
  it('rejects forged, expired, wrong-route and modified private handoffs',()=>{
    const key=randomBytes(32).toString('hex'),body={state:opaque(),code:opaque()},headers=new Headers(signHandoff(key,COMPLETE_PATH,body));
    expect(verifyHandoff(key,COMPLETE_PATH,body,headers).nonceHash).toMatch(/^[a-f0-9]{64}$/);
    for(const run of [()=>verifyHandoff(key,REGISTER_PATH,body,headers),()=>verifyHandoff(key,COMPLETE_PATH,{...body,code:opaque()},headers),()=>verifyHandoff(key,COMPLETE_PATH,body,headers,Date.now()+61000),()=>verifyHandoff(key,COMPLETE_PATH,body,new Headers()),()=>verifyHandoff(randomBytes(32).toString('hex'),COMPLETE_PATH,body,headers)])expect(run).toThrow('OAUTH_PRIVATE_HANDOFF_REJECTED');
  });
  it('accepts only the exact configured loopback operator origin',()=>{
    const origin='http://127.0.0.1:3000';expect(()=>operatorOrigin(origin,origin)).not.toThrow();
    for(const value of [undefined,'null','https://attacker.example','http://localhost:3000'])expect(()=>operatorOrigin(value,origin)).toThrow();
    expect(()=>operatorOrigin('https://attacker.example','https://attacker.example')).toThrow();
  });
  it('bounds OAuth handoff bodies independently of other native API routes',()=>{
    const key=randomBytes(32).toString('hex'),body={code:'x'.repeat(12001)},headers=new Headers(signHandoff(key,COMPLETE_PATH,body));
    expect(()=>verifyHandoff(key,COMPLETE_PATH,body,headers)).toThrow('OAUTH_PRIVATE_HANDOFF_REJECTED');
  });
  it('browser cookie is separate from internal sender credentials',()=>{
    const value=opaque();expect(browserCookie({cookie:'unrelated=x; '+NATIVE_COOKIE+'='+value})===value).toBe(true);expect(browserCookie({})).toBeUndefined();
    expect(()=>routerOrigin('http://attacker.example',true)).toThrow();expect(()=>routerOrigin('http://127.0.0.1:9999',false)).toThrow();expect(()=>routerOrigin('https://router.example/?next=untrusted',false)).toThrow();
  });
});
