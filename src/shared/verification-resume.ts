/** Only website-check takeovers may return automatically; ordinary browsing stays manual. */
export interface VerificationObservation {
  url: string;
  ready: boolean;
  content: boolean;
  gates: { captcha: boolean; blocked: boolean; login: boolean; payment?: boolean; ageGate?: boolean };
}
const pageKey=(url:string)=>{try{const u=new URL(url);return /^https?:$/.test(u.protocol)?u.origin+u.pathname.replace(/\/$/,''):null}catch{return null}};
export class VerificationResume {
  private settled=0;
  private expected:string|null;
  constructor(url:string){this.expected=pageKey(url)}
  observe(page:VerificationObservation):boolean {
    const gates=page.gates;
    const valid=this.expected!==null&&pageKey(page.url)===this.expected&&page.ready&&page.content&&!gates.captcha&&!gates.blocked&&!gates.login&&!gates.payment&&!gates.ageGate;
    this.settled=valid?this.settled+1:0;
    return this.settled>=2;
  }
}
