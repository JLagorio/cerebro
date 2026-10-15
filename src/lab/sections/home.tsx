import { useEffect } from 'react';
import { armedFaults } from '@/lib/mockFaults';
import { useVaultStore } from '@/stores/vaultStore';
import type { HomeLaneId } from '@/engine/homeLanes';
import { HomeLanes } from '@/pages/home/HomeLanes';
import { HOME_PRESETS } from '@/pages/home/home.presets';
import type { LabSection } from '../presets';

function Stage({ id }: { id: HomeLaneId }) {
  useEffect(() => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault !== null && armedFaults().scan_vault !== undefined)
      void useVaultStore.getState().openVault(vault);
  }, []);
  return <HomeLanes only={id} />;
}
export const sections: LabSection[] = HOME_PRESETS.map(({ id, title, states }) => ({
  id: `home-${id}`,
  title,
  surface: 'Home',
  states,
  render: () => <Stage id={id} />,
}));
