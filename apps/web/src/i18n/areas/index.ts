/** Customer-dashboard copy split by area; spread into ../es.ts and ../en.ts. */
import { connectEn, connectEs } from './connect';
import { teamEn, teamEs } from './team';
import { shellEn, shellEs } from './shell';
import { usageEn, usageEs } from './usage';

export const areasEs = { ...connectEs, ...teamEs, ...shellEs, ...usageEs } as const;
export const areasEn: Record<keyof typeof areasEs, string> = { ...connectEn, ...teamEn, ...shellEn, ...usageEn };
