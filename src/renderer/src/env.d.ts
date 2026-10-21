import type { DocraftApi } from '../../shared/api'

declare global {
  interface Window {
    docraft: DocraftApi
  }
}

export {}
