// Visibility policy. One switch decides it: hiding games with a woman on the
// cover also hides adult (NSFW) games; with it off the Store shows everything.
// The separate NSFW switch and its consent record from versions before 0.2.12
// are cleared on start. Every change bumps the policy revision.
import { EventEmitter } from 'node:events';
import type { VisibilityPolicy } from '@shared/policy';
import type { ConsentRepo, SettingsRepo } from './repos';
import type { Settings } from '@shared/types';

export class PolicyService extends EventEmitter {
  constructor(
    private settings: SettingsRepo,
    consent: ConsentRepo,
  ) {
    super();
    if (settings.get().showNsfw) settings.setShowNsfw(false);
    if (consent.current().accepted) consent.revoke();
  }

  policy(): VisibilityPolicy {
    return this.settings.policy();
  }

  /** Hides or shows Store games whose cover's main subject is a woman. */
  setHideWomenCovers(on: boolean): Settings {
    const s = this.settings.setHideWomenCovers(on);
    this.emit('changed', { showNsfw: this.policy().showNsfw, revision: s.policyRevision });
    return s;
  }
}
