// NSFW consent and visibility policy. Enabling requires the warning to have
// been accepted in this request; disabling revokes consent so re-enabling
// asks again. Every change bumps the policy revision.
import { EventEmitter } from 'node:events';
import { ADULT_WARNING_TEXT, type VisibilityPolicy } from '@shared/policy';
import type { ConsentRepo, SettingsRepo } from './repos';
import { warningHash } from './repos';
import type { Settings } from '@shared/types';

export class PolicyService extends EventEmitter {
  constructor(
    private settings: SettingsRepo,
    private consent: ConsentRepo,
  ) {
    super();
    // Self-heal: NSFW may only be on while a consent record exists.
    const s = settings.get();
    if (s.showNsfw && !consent.current().accepted) settings.setShowNsfw(false);
  }

  policy(): VisibilityPolicy {
    return this.settings.policy();
  }

  enable(acceptedWarning: true): Settings {
    if (acceptedWarning !== true) throw new Error('The adult content warning must be accepted');
    this.consent.accept(warningHash(ADULT_WARNING_TEXT));
    const s = this.settings.setShowNsfw(true);
    this.emit('changed', { showNsfw: s.showNsfw, revision: s.policyRevision });
    return s;
  }

  disable(): Settings {
    this.consent.revoke();
    const s = this.settings.setShowNsfw(false);
    this.emit('changed', { showNsfw: s.showNsfw, revision: s.policyRevision });
    return s;
  }
}
