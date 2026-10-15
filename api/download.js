import { createDownloadHandler } from '../server/download.mjs';
import { withPublicConfig } from '../server/runtime-config.mjs';

export default createDownloadHandler({ env: withPublicConfig() });
