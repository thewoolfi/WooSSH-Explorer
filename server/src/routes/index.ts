import { Router } from 'express';

import { registerConnectionRoutes } from './connections.js';
import type { RouteContext } from './context.js';
import { registerFileRoutes } from './fs.js';
import { registerKnownHostRoutes } from './knownHosts.js';
import { registerNetToolRoutes } from './netTools.js';
import { registerProfileRoutes } from './profiles.js';
import { registerSecretRoutes } from './secrets.js';
import { registerSettingsRoutes } from './settings.js';
import { registerStatsRoutes } from './stats.js';
import { registerSystemRoutes } from './system.js';
import { registerTransferRoutes } from './transfers.js';
import { registerUpdateRoutes } from './update.js';

/**
 * Mounts every `/api` route. One router keeps ordering explicit: static paths first, then the
 * `:id` scoped routes.
 */
export function registerRoutes(ctx: RouteContext, basePath = '/api'): Router {
  const router = Router();

  registerSystemRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerKnownHostRoutes(router, ctx);
  registerProfileRoutes(router, ctx);
  registerSecretRoutes(router, ctx);
  registerConnectionRoutes(router, ctx);
  registerStatsRoutes(router, ctx);
  registerNetToolRoutes(router, ctx);
  registerUpdateRoutes(router, ctx);
  registerFileRoutes(router, ctx);
  registerTransferRoutes(router, ctx);

  const parent = Router();
  parent.use(basePath, router);
  return parent;
}
