import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('deployment entrypoints parse as files in Windows PowerShell 5 with Chinese messages intact', {skip:process.platform!=='win32'},()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const names=['export-secondary.ps1','secondary-computer.ps1','prepare-ui-components.ps1','ui-runtime.ps1','manage.ps1'];
  for(const name of names){
    const bytes=fs.readFileSync(path.join(root,'scripts',name));
    assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf',name+' must declare UTF-8 to Windows PowerShell');
  }
  const command=`$failures=@(); foreach($name in @(${names.map(name=>"'scripts/"+name+"'").join(',')})) { $tokens=$null; $parseErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $name),[ref]$tokens,[ref]$parseErrors); if($parseErrors.Count -gt 0) {$failures+=$name} }; if($failures.Count -gt 0) {$failures | ConvertTo-Json -Compress; exit 1}; Write-Output 'entrypoints-parse-ok'`;
  const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=spawnSync(executable,['-NoProfile','-NonInteractive','-Command',command],{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/entrypoints-parse-ok/);
});
