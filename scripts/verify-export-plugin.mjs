import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SOURCE_PLUGIN_ZIP,verifySourcePluginZip} from './source-release-policy.mjs';

// Validate bytes supplied by the exporter; neither the archive nor its source
// entry point is imported. The exporter writes this same buffer to the bundle.
export function verifyExportPlugin(root,bytes){
  const checked=verifySourcePluginZip(root,bytes);
  return {archive:SOURCE_PLUGIN_ZIP,sha256:checked.sha256,sourceFiles:checked.entries.map(entry=>'optional-extensions/fish-notebook/'+entry.name)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))throw Error('EXPORT_PLUGIN_ROOT_REQUIRED');
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){if((size+=chunk.length)>8*1024*1024)throw Error('EXPORT_PLUGIN_TOO_LARGE');chunks.push(chunk);}
    process.stdout.write(JSON.stringify(verifyExportPlugin(process.argv[2],Buffer.concat(chunks))));
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
