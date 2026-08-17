import { register } from 'node:module'

/** `node --import` entry point that installs `child-resolve.mjs`. */
register('./child-resolve.mjs', import.meta.url)
