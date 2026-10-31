/** GET /api/config: which sign-ins are on, server library, version. Mirrors ServerConfig in app/src/core/types.ts. */
export async function configRoutes(app) {
  app.get('/api/config', async () => {
    const c = app.config;
    return {
      version: c.version,
      signIn: { google: c.google.enabled, x: c.x.enabled, local: c.allowLocalAccounts },
      signups: c.allowSignups,
      serverLibrary: Boolean(c.musicDir),
      chatgptPlan: c.chatgpt.enabled,
      appScheme: c.appScheme,
      publicUrl: c.publicUrl,
      ...(c.spotifyClientId ? { spotifyClientId: c.spotifyClientId } : {}),
      edition: c.edition,
      // online edition: sign-ins, plans and included AI (src/online, onlineHooks.configInfo)
      ...(c.online.enabled ? { online: app.onlineHooks.configInfo() } : {}),
    };
  });
}
