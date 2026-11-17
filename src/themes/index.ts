import type { Check } from '../core/types.ts'
import { checks as images } from './01-images.ts'
import { checks as cadres } from './02-cadres.ts'
import { checks as couleurs } from './03-couleurs.ts'
import { checks as multimedia } from './04-multimedia.ts'
import { checks as tableaux } from './05-tableaux.ts'
import { checks as liens } from './06-liens.ts'
import { checks as scripts } from './07-scripts.ts'
import { checks as elementsObligatoires } from './08-elements-obligatoires.ts'
import { checks as structuration } from './09-structuration.ts'
import { checks as presentation } from './10-presentation.ts'
import { checks as formulaires } from './11-formulaires.ts'
import { checks as navigation } from './12-navigation.ts'
import { checks as consultation } from './13-consultation.ts'

/** Toutes les vérifications, dans l'ordre des thématiques du RGAA. */
export const allChecks: Check[] = [
  ...images,
  ...cadres,
  ...couleurs,
  ...multimedia,
  ...tableaux,
  ...liens,
  ...scripts,
  ...elementsObligatoires,
  ...structuration,
  ...presentation,
  ...formulaires,
  ...navigation,
  ...consultation,
]
