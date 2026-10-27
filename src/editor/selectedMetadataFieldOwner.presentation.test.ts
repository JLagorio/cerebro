// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { __resetOpenPages } from './openPages';
import { subscribeRecovery } from './deletedDraftRecovery';
import { attachSelectedMetadataField } from './selectedMetadataFieldOwner';
import type { SelectedPropertySnapshot } from '@/lib/generated/workspace';
beforeEach(()=>__resetOpenPages());afterEach(()=>__resetOpenPages());
it('last property presentation release notifies the already-mounted global recovery host',()=>{
 const target={workspaceId:'915781f1-6812-478c-8063-3f41322547f5',recordId:'76b64da5-34b6-45f2-8ab2-e2779227ace3'};
 const frame:SelectedPropertySnapshot={path:'page.md',field:'code',target,version:{kind:'sqlite_metadata',...target,metadataRevision:'1',metadataHash:'a'.repeat(64),bodyHash:'b'.repeat(64)},value:{kind:'present',value:{kind:'string',value:'before'}},editable:true,coherence:'paired',observedBodyHash:'b'.repeat(64)};
 const attached=attachSelectedMetadataField({vault:'/presentation',path:'page.md',target,field:'code'},frame,{read:async()=>frame,patch:async()=>{throw new Error('must not dispatch');},mintKey:()=>{throw new Error('must not mint');}});
 if(!attached)throw new Error('actual owner missing');attached.owner.edit('retained dirty text');
 const changed=vi.fn();const stop=subscribeRecovery(changed);attached.release();
 expect(attached.owner.isPresented()).toBe(false);expect(changed).toHaveBeenCalled();stop();
});
