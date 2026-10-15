import { createConfigHandler } from '../server/public-config.mjs';
import { withPublicConfig } from '../server/runtime-config.mjs';

export default createConfigHandler({ env: withPublicConfig() });
