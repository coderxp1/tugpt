// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Collection, LibraryDocument } from '@/lib/workspace-data/contracts';
import { MoveDocument } from '../MoveDocument';
import { fakeApi, iso } from './fake-api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const source: Collection={id:'c1',name:'Source',description:null,visibility:'private',ownedByMe:true,createdAt:iso(1),updatedAt:iso(1)};
const document: LibraryDocument={id:'d1',collectionId:'c1',fileId:'f1',title:'Policy',status:'ready',errorCode:null,chunkCount:1,indexedAt:iso(1),createdAt:iso(1),processingAttempts:0,nextAttemptAt:null};
it.each([201,503])('only removes source after confirmed destination (%s)',async status=>{
 const moved=vi.fn();const api=fakeApi({
 'GET /api/v1/library/collections':()=>({body:{collections:[source,{...source,id:'c2',name:'Target'},{...source,id:'c3',name:'Shared',visibility:'organization'},{...source,id:'c4',name:'Not mine',ownedByMe:false}]}}),
 'POST /api/v1/library/collections/:id/documents':()=>({status,body:status===201?{document:{...document,id:'d2',collectionId:'c2'}}:{error:'UNAVAILABLE'}}),
 'DELETE /api/v1/library/collections/:id/documents/:doc':()=>({body:{deleted:true}})
 });
 render(<MoveDocument source={source} document={document} onClose={()=>{}} onMoved={moved}/>);
 await screen.findByRole('option',{name:'Target'});expect(screen.queryByRole('option',{name:'Shared'})).toBeNull();expect(screen.queryByRole('option',{name:'Not mine'})).toBeNull();
 fireEvent.change(screen.getByLabelText('Destination collection'),{target:{value:'c2'}});fireEvent.click(screen.getByRole('button',{name:'Move'}));
 if(status===201) await waitFor(()=>expect(moved).toHaveBeenCalledOnce());else await screen.findByRole('alert');
 const writes=api.calls.filter(c=>c.method!=='GET');expect(writes.map(c=>c.method)).toEqual(status===201?['POST','DELETE']:['POST']);expect(writes[0].body).toEqual({fileId:'f1',title:'Policy'});
 expect(writes.some(c=>c.path==='/api/v1/files/f1')).toBe(false);
});
