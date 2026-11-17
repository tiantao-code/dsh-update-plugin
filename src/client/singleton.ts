import { UpdateStore } from './store.js'

/** One panel instance per browser bundle; the slot may mount it more than once. */
export const store = new UpdateStore()
