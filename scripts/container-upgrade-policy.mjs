import assert from 'node:assert/strict';

// This is an immutable, independently checked public release, not a channel.
export const upgradeBaseline=Object.freeze({
  tag:'v0.25.0beta',version:'0.25.0-beta',commit:'91c56352daffe2289392165390ffd36c0889bbe0',
  image:'ghcr.io/suiren-kazutohashimoto/mirea:0.25.0beta',
  digestReference:'ghcr.io/suiren-kazutohashimoto/mirea@sha256:eb4b23c8b11f4261fff66e95038101a60035977991c8f25acba0d32c5f2e5e5a',
  metadataUrl:'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.25.0beta/mirea-0.25.0beta-container.json'
});
export function verifyUpgradeBaseline(metadata){
  assert(metadata?.schemaVersion===1&&metadata.platform==='linux/amd64','Unexpected baseline metadata');
  for(const key of ['tag','version','commit','image','digestReference'])assert.equal(metadata[key],upgradeBaseline[key],'Published baseline identity changed: '+key);
  for(const key of ['testedImagePromoted','readOnlyRoot','separateStorageVerified','containerRecreationAndEncryptionVerified'])assert.equal(metadata[key],true,'Baseline lacks verification: '+key);
  assert.equal(metadata.nonRoot,'1000:1000');return upgradeBaseline;
}
export const fixtureProject=name=>/^mirea-ci-\d+-\d+(?:-separated|-(?:upgrade|restore)-(?:combined|separated))?$/.test(name??'');
export function upgradeProjects(env){
  assert(env.GITHUB_ACTIONS==='true'&&/^mirea-ci-\d+-\d+$/.test(env.COMPOSE_PROJECT_NAME??''),'An isolated GitHub CI project is required');
  return ['combined','separated'].map((layout,index)=>({layout,source:env.COMPOSE_PROJECT_NAME+'-upgrade-'+layout,restored:env.COMPOSE_PROJECT_NAME+'-restore-'+layout,port:31301+index,restorePort:31303+index}));
}
export function ownedUpgradeVolume(info,project,logical){
  assert(/^mirea-ci-\d+-\d+-(?:upgrade|restore)-(?:combined|separated)$/.test(project),'Not an upgrade fixture project');
  assert(['mirea-data','mirea-media'].includes(logical),'Not a fixture storage volume');
  assert.equal(info?.Name,project+'_'+logical,'Unexpected volume name');
  assert.equal(info.Labels?.['com.docker.compose.project'],project,'Refusing another project volume');
  assert.equal(info.Labels?.['com.docker.compose.volume'],logical,'Unexpected storage identity');
  assert.equal(info.Driver,'local','Only isolated local Docker volumes are permitted');
  assert(!info.Options||Object.keys(info.Options).length===0,'Host binds and external storage are not permitted');
  return info.Name;
}
export function restoredUpgradeConfig(original,project,port){
  assert(/^mirea-ci-\d+-\d+-restore-(?:combined|separated)$/.test(project));
  assert(Number.isInteger(port)&&port>=31301&&port<=31304);
  const config=structuredClone(original);assert.deepEqual(Object.keys(config.services),['mirea']);
  const service=config.services.mirea;assert.equal(service.image,upgradeBaseline.digestReference);
  assert(service.volumes.length>=1&&service.volumes.length<=2);
  for(const volume of service.volumes)assert(volume.type==='volume'&&['mirea-data','mirea-media'].includes(volume.source)&&volume.target===(volume.source==='mirea-data'?'/data':'/media'),'Unexpected fixture mount');
  for(const [name,volume]of Object.entries(config.volumes)){assert(['mirea-data','mirea-media'].includes(name)&&!volume.external&&!volume.driver_opts,'Unexpected fixture volume');volume.name=project+'_'+name;}
  assert.deepEqual(Object.keys(config.networks),['default']);assert(!config.networks.default.external);config.networks.default.name=project+'_default';
  assert(service.ports.length===1&&service.ports[0].host_ip==='127.0.0.1'&&service.ports[0].target===3000);service.ports[0].published=String(port);
  config.name=project;delete service.build;return config;
}
