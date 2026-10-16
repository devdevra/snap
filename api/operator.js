import { createOperatorHandler } from '../server/operator.mjs';
import { withPublicConfig } from '../server/runtime-config.mjs';

export default createOperatorHandler({ env: withPublicConfig() });
