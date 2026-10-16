import { createHealthHandler } from '../server/health.mjs';
import { withPublicConfig } from '../server/runtime-config.mjs';

export default createHealthHandler({ env: withPublicConfig() });
