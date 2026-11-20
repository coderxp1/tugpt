/** Customer-dashboard copy split by area; spread into ../es.ts and ../en.ts. */
import { connectEn, connectEs } from './connect';
import { teamEn, teamEs } from './team';

export const areasEs = { ...connectEs, ...teamEs } as const;
export const areasEn: Record<keyof typeof areasEs, string> = { ...connectEn, ...teamEn };
