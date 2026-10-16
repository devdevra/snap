import { createPreviewHandler } from '../server/download.mjs';
import { withPublicConfig } from '../server/runtime-config.mjs';

export default createPreviewHandler({ env: withPublicConfig() });
