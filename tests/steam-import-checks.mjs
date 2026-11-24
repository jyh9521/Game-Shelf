import assert from "node:assert/strict";
export const stable = value => ({...value,exportedAt:""});
export function assertion(loginUrl, steamId="76561198000000001") {
  const returnTo = new URL(loginUrl).searchParams.get("openid.return_to");
  const query = new URL(returnTo).searchParams;
  Object.entries({ns:"http://specs.openid.net/auth/2.0",mode:"id_res",op_endpoint:"https://steamcommunity.com/openid/login",
    claimed_id:"https://steamcommunity.com/openid/id/"+steamId, identity:"https://steamcommunity.com/openid/id/"+steamId,
    return_to:returnTo,response_nonce:new Date().toISOString().replace(/\.\d{3}Z$/,"Z")+"qa-nonce",assoc_handle:"qa",
    signed:"op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",sig:"qa-valid"
  }).forEach(([key,value])=>query.set("openid."+key,value));
  return {query:query.toString(),returnTo};
}
export async function connect(api, id) {
  const login=await api("steam/account/start","POST",{}), input=assertion(login.url,id);
  const account=await api("steam/account/complete","POST",{query:input.query});
  assert.equal(account.steamId,id??"76561198000000001");
  return input;
}
export async function checkSteamImport(api) {
  await api("steam/account","DELETE");
  const before=stable(await api("backup"));
  await api("steam/import/preview","POST",{},409);
  const identity=await connect(api);
  await api("steam/account/complete","POST",{query:identity.query},400);
  assert.deepEqual(stable(await api("backup")),before,"authentication must not enter backup");
  const target=await api("games","POST",{title:"QA manual import target",rating:5,memo:"KEEP MEMO",description:"KEEP DESCRIPTION",manualFields:["title","description"],
    ownership:{platformId:"PC",storeId:"GOG",manualTotalOverride:777,manualExtraSeconds:33}},201);
  const original=await api("games/"+target.id), fields=await api("games/"+target.id+"/fields");
  const preview=await api("steam/import/preview","POST",{});
  assert.equal(preview.items.length,13); assert.equal(preview.links.length,0);
  const input={token:preview.token,confirmed:true,choices:[{appid:90001,gameId:target.id},{appid:90002,gameId:null},{appid:90003,gameId:null}]};
  const unchanged=stable(await api("backup"));
  await api("steam/import","POST",{...input,confirmed:false},400);
  await api("steam/import","POST",{...input,choices:[{appid:90004,gameId:null},{appid:90005,gameId:"foreign-or-deleted"}]},404);
  await api("steam/import","POST",{...input,choices:[{appid:999,gameId:null}]},400);
  assert.deepEqual(stable(await api("backup")),unchanged,"invalid batch must be atomic");
  const imported=await api("steam/import","POST",input);
  assert.equal(imported.created,3);assert.equal(imported.duplicate,0);
  const after=stable(await api("backup"));
  assert.equal(after.schema_version,4);assert.equal(after.steamLinks.length,3);
  assert.equal(after.items.find(i=>i.id===imported.items[0].libraryItemId).sourceTotalSeconds,0);
  assert.equal(after.items.find(i=>i.id===imported.items[1].libraryItemId).sourceTotalSeconds,null);
  assert.equal(after.items.find(i=>i.id===imported.items[2].libraryItemId).sourceTotalSeconds,7800);
  assert.equal(after.items.find(i=>i.id===imported.items[0].libraryItemId).acquisitionType,"UNKNOWN");
  const current=await api("games/"+target.id);
  assert.deepEqual(current.profiles,original.profiles);assert.equal(current.description,"KEEP DESCRIPTION");assert.equal(current.title,original.title);
  assert.deepEqual(await api("games/"+target.id+"/fields"),fields);
  const oldItem=original.releases[0].contents[0].item;
  assert.deepEqual(current.releases.flatMap(r=>r.contents).find(c=>c.item.id===oldItem.id).item,oldItem);
  for(let i=0;i<2;i++){const duplicate=await api("steam/import","POST",input);assert.equal(duplicate.created,0);assert.equal(duplicate.duplicate,3);}
  await api("steam/import","POST",{...input,choices:[{appid:90002,gameId:target.id}]},409);
  assert.deepEqual(stable(await api("backup")),after);
  const refresh=await api("steam/import/preview","POST",{});assert.equal(refresh.links.length,3);
  await api("steam/import","POST",input,409);
  await api("steam/account","DELETE");assert.deepEqual(stable(await api("backup")),after);
  await api("steam/import","POST",{...input,token:refresh.token},409);
  await connect(api);const reconnected=await api("steam/import/preview","POST",{});
  assert.equal((await api("steam/import","POST",{...input,token:reconnected.token})).duplicate,3);
  await connect(api,"76561198000000002");assert.equal((await api("steam/import/preview","POST",{})).state,"no_visible_games");
  await connect(api,"76561198000000004");await api("steam/import/preview","POST",{},429);
  await connect(api,"76561198000000008");const missing=await api("steam/import/preview","POST",{});
  await api("steam/import","POST",{token:missing.token,confirmed:true,choices:[{appid:90050,gameId:null}]},400);
  assert.deepEqual(stable(await api("backup")),after);
  await connect(api);
  return {backup:after,target:target.id,imported};
}
