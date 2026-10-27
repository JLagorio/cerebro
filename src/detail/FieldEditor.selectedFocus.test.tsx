// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type { SelectedPropertySnapshot } from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages } from '@/editor/openPages';
import { FieldEditor } from './FieldEditor';
beforeEach(()=>{cleanup();__resetOpenPages();vi.restoreAllMocks();});afterEach(()=>{cleanup();__resetOpenPages();vi.restoreAllMocks();});
it('selected checkbox Done returns keyboard focus to its existing grid without writing',async()=>{
 const target={workspaceId:'915781f1-6812-478c-8063-3f41322547f5',recordId:'76b64da5-34b6-45f2-8ab2-e2779227ace3'};
 const snapshot:SelectedPropertySnapshot={path:'focus.md',field:'flag',target,version:{kind:'sqlite_metadata',...target,metadataRevision:'1',metadataHash:'a'.repeat(64),bodyHash:'b'.repeat(64)},observedBodyHash:'b'.repeat(64),coherence:'paired',editable:true,value:{kind:'present',value:{kind:'boolean',value:true}}};
 const entry=makeEntry({path:'focus.md',authority:snapshot.version,hash:snapshot.version.bodyHash,properties:{flag:true}});
 useVaultStore.setState({vaultPath:'/field-focus',entriesVault:'/field-focus',status:'ready',entries:[entry]});vi.spyOn(ipc,'supportsSelectedEditor').mockReturnValue(true);vi.spyOn(ipc,'readSelectedProperty').mockResolvedValue(snapshot);vi.spyOn(ipc,'patchSelectedMetadata');
 render(<div role="grid" tabIndex={0} aria-label="Focus records"><FieldEditor entry={entry} def={{name:'flag',kind:'checkbox'}} schema={buildSchema([entry])}/></div>);
 fireEvent.click(screen.getByRole('button',{name:'Edit Flag'}));expect(await screen.findByRole('switch',{name:'Flag'})).toBeTruthy();
 const done=screen.getByRole('button',{name:'Done'});done.focus();expect(document.activeElement).toBe(done);fireEvent.click(done);
 expect(screen.getByRole('button',{name:'Edit Flag'})).toBeTruthy();expect(document.activeElement).toBe(screen.getByRole('grid',{name:'Focus records'}));expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
});
