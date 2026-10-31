/** GET /api/health: liveness + db check. */
export async function healthRoutes(app) {
  app.get('/api/health', async () => {
    app.db.prepare('SELECT 1').get();
    return { ok: true, version: app.config.version, time: Date.now() };
  });
}
