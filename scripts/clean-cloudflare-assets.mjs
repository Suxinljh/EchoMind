import { rm } from 'node:fs/promises'

await rm('dist/models', { recursive: true, force: true })
console.log('已从静态资源中移除 R2 模型文件')
