import {describe,it,expect} from 'vitest';
import {VerificationResume,type VerificationObservation} from '../src/shared/verification-resume';
const page:VerificationObservation={url:'https://games.test/all-games/',ready:true,content:true,gates:{captcha:false,blocked:false,login:false}};
describe('Returning from website verification',()=>{
  it('requires two consecutive settled reads of the actual checked page',()=>{const check=new VerificationResume(page.url);expect(check.observe(page)).toBe(false);expect(check.observe(page)).toBe(true)});
  it('does not reclaim control during challenges, loading, login, payment or an empty document',()=>{
    for(const unsafe of [{...page,ready:false},{...page,content:false},...['captcha','blocked','login','payment','ageGate'].map(key=>({...page,gates:{...page.gates,[key]:true}}))]){
      const check=new VerificationResume(page.url);expect(check.observe(page)).toBe(false);expect(check.observe(unsafe)).toBe(false);expect(check.observe(page)).toBe(false);
    }
  });
  it('does not mistake another website or a different page for completion',()=>{
    const check=new VerificationResume(page.url);for(const url of ['https://other.test/all-games/','https://games.test/','about:blank'])expect(check.observe({...page,url})).toBe(false);
    expect(check.observe({...page,url:'https://games.test/all-games#games'})).toBe(false);expect(check.observe(page)).toBe(true);
  });
});
