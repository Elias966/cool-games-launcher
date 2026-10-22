// Whether DLSS 5 Neural Rendering runs in a game: its own choice in Launch
// options, or, when it follows Settings, the "use in all games" switch.
import type { LaunchOptions } from './types';

export type Dlss5Choice = 'auto' | 'on' | 'off';

/** The game's choice; games set up before the three-way choice had a plain switch. */
export function dlss5Choice(launch: Partial<Pick<LaunchOptions, 'dlss5' | 'neuralRendering'>>): Dlss5Choice {
  if (launch.dlss5 === 'on' || launch.dlss5 === 'off') return launch.dlss5;
  return launch.neuralRendering ? 'on' : 'auto';
}

export function dlss5On(launch: Partial<Pick<LaunchOptions, 'dlss5' | 'neuralRendering'>>, allGames: boolean): boolean {
  const c = dlss5Choice(launch);
  return c === 'on' || (c === 'auto' && allGames);
}
