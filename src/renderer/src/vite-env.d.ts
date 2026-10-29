/// <reference types="vite/client" />

import type { KageShelfApi } from '../../shared/types'

declare global {
  interface Window {
    kageShelf: KageShelfApi
  }
}

export {}
