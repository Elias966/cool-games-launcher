// Enterprise policies baked into the bundled Firefox (distribution/policies.json).
// Path-dependent extension installation is handled per profile at
// runtime because the AppImage mount point changes on every launch.
export function firefoxPolicies() {
  return {
    policies: {
      DisableAppUpdate: true,
      DisableTelemetry: true,
      DisableFirefoxStudies: true,
      DisablePocket: true,
      DisableFeedbackCommands: true,
      DisableSetDesktopBackground: true,
      DontCheckDefaultBrowser: true,
      NoDefaultBookmarks: true,
      OverrideFirstRunPage: '',
      OverridePostUpdatePage: '',
      PasswordManagerEnabled: false,
      OfferToSaveLogins: false,
      PromptForDownloadLocation: false,
      UserMessaging: {
        ExtensionRecommendations: false,
        FeatureRecommendations: false,
        UrlbarInterventions: false,
        SkipOnboarding: true,
        MoreFromMozilla: false,
        FirefoxLabs: false,
      },
      FirefoxHome: { Search: false, TopSites: false, SponsoredTopSites: false, Highlights: false, Pocket: false, SponsoredPocket: false, Snippets: false },
      ExtensionSettings: {
        '*': { installation_mode: 'blocked' },
        'uBlock0@raymondhill.net': { installation_mode: 'allowed' },
        '{c3c10168-4186-445c-9c5b-63f12b8e2c87}': { installation_mode: 'allowed', default_area: 'navbar' },
      },
    },
  };
}
