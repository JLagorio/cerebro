// @vitest-environment jsdom
import { cleanup,render,screen,within } from '@testing-library/react';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { __resetOpenPages } from './openPages';
import { selectedTitleOwner } from './selectedTaskOwner';
import { attachSelectedMetadataField } from './selectedMetadataFieldOwner';
import { useVaultStore } from '@/stores/vaultStore';
import { RetainedSavesHost } from './RetainedSavesHost';
import type { SelectedRecordVersion } from '@/lib/generated/workspace';
beforeEach(()=>{cleanup();__resetOpenPages();});afterEach(()=>{cleanup();__resetOpenPages();});
it('actual App retained-saves composition has one bounded position for simultaneous title and property owners',()=>{
 const vault='/retained-page-saves';const path='page.md';const target={workspaceId:'915781f1-6812-478c-8063-3f41322547f5',recordId:'76b64da5-34b6-45f2-8ab2-e2779227ace3'};
 const version:SelectedRecordVersion={kind:'sqlite_metadata',...target,metadataRevision:'1',metadataHash:'a'.repeat(64),bodyHash:'b'.repeat(64)};
 useVaultStore.setState({vaultPath:vault,entriesVault:vault,status:'ready'});
 const title=selectedTitleOwner(vault,{target,path,body:'# Before\n',version,observedBodyHash:version.bodyHash,coherence:'paired',editable:true});title.edit('# Authored title\n','source');
 const field=attachSelectedMetadataField({vault,path,target,field:'code'},{path,target,field:'code',version,observedBodyHash:version.bodyHash,coherence:'paired',editable:true,value:{kind:'present',value:{kind:'string',value:'before'}}},{read:async()=>{throw new Error('no read');},patch:async()=>{throw new Error('no write');},mintKey:()=>{throw new Error('no request');}});
 if(!field)throw new Error('actual field owner absent');field.owner.edit('007');field.release();
 render(<RetainedSavesHost/>);
 expect(screen.getByRole('button',{name:'Save title'})).toBeTruthy();expect(screen.getByRole('button',{name:'Save property'})).toBeTruthy();
 const trays=screen.getAllByRole('complementary');expect(trays).toHaveLength(1);
 expect(within(trays[0]).getByRole('button',{name:'Save title'})).toBeTruthy();expect(within(trays[0]).getByRole('button',{name:'Save property'})).toBeTruthy();
});
