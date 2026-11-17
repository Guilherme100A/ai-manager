// GitHub browser only; no business writes. The operator independently revokes every test credential.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { LOGIN_VERIFICATION_ORIGIN as base, secureClient, revokeTemporarySessions } from './live-login-transport.mjs'
assert.equal(process.env.GITHUB_ACTIONS,'true','Use the authorized GitHub runner')
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0','TLS must stay enabled')
assert.match(process.env.GITHUB_RUN_ID??'',/^\d+$/,'Owned run required')
let sessions
try {sessions=JSON.parse(process.env.AREAS_SMOKE_SESSIONS??'')} catch {throw Error('Technical sessions missing; credentials withheld')}
assert.ok(Array.isArray(sessions)&&sessions.length===3,'Three independent technical sessions required')
for(const s of sessions)assert.ok(typeof s.token==='string'&&s.token.startsWith('wsm1.')&&Date.parse(s.expiresAt)>Date.now()&&Date.parse(s.expiresAt)-Date.now()<=20*60000,'Use short-lived technical sessions')
const secure=secureClient(base),request=(route,options={})=>secure(route,{...options,signal:AbortSignal.timeout(45000)}),{chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const browser=await chromium.launch({headless:true}),contexts=[],pages=[],cookies=new Set(),users=[],areaIds=[],chips=[],errors=[],blocked=[]
const marker='AIManager-BusinessAreas-Smoke/'+process.env.GITHUB_RUN_ID,key='wsm.remembered-session'
const allowed=new Set(['/api/crm/sso','/crm/api/auth/sso','/crm/api/auth/logout'])
let stage='initialize',failed=false
async function choose(page,id){
  const frame=page.frameLocator('[data-testid="crm-frame"]')
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/crm/api/offers/resources'&&r.request().headers()['x-business-area-id']===id&&r.status()===200)
  await frame.getByLabel('Área de negócio',{exact:true}).selectOption(id)
  const data=await(await response).json()
  assert.equal(data.business_area?.id,id,'API must use the selected area')
  await frame.getByRole('heading',{name:'Ofertas compartilhadas'}).waitFor()
  assert.equal(await frame.getByLabel('Área de negócio',{exact:true}).inputValue(),id)
  return data.connections.map(c=>c.id).sort()
}
try{
  for(let i=0;i<3;i++){
    stage='admin-session-'+(i+1)
    const c=await browser.newContext({ignoreHTTPSErrors:false,userAgent:marker,serviceWorkers:'block',viewport:{width:1440,height:900}})
    contexts.push(c)
    await c.route('**/*',async route=>{
      const r=route.request(),url=new URL(r.url())
      if(url.protocol!=='https:'||url.origin!==base){blocked.push('unexpected-origin');await route.abort();return}
      if(!['GET','HEAD','OPTIONS'].includes(r.method())&&!allowed.has(url.pathname)){blocked.push('unexpected-business-write');await route.abort();return}
      await route.continue()
    })
    const page=await c.newPage();pages.push(page);page.on('pageerror',()=>errors.push('pageerror'))
    await page.goto(base+'/#/login')
    await page.evaluate(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key,session:sessions[i]})
    await page.reload();await page.getByTestId('nav-crm').click()
    const frame=page.frameLocator('[data-testid="crm-frame"]')
    await frame.getByTestId('nav-item-offers').click();await frame.getByRole('heading',{name:'Ofertas compartilhadas'}).waitFor()
    const profile=await c.request.get(base+'/crm/api/auth/profile');assert.equal(profile.status(),200)
    const p=await profile.json();users.push(p.user.id)
    assert.ok(p.companies.some(company=>company.business_areas_admin===true),'Only the authorized administrator may use areas')
    const areas=await c.request.get(base+'/crm/api/business-areas');assert.equal(areas.status(),200)
    const items=(await areas.json()).items;assert.deepEqual(items.map(a=>a.slot),[1,2,3])
    areaIds.push(items[i].id)
    if(i===1)await page.setViewportSize({width:390,height:844})
    chips.push(await choose(page,items[i].id))
    const content=await page.locator('[data-testid="crm-frame"]').contentFrame()
    assert.equal(await content.locator('html').evaluate(el=>el.scrollWidth<=innerWidth),true,'Area screen must fit mobile/desktop')
    const cookie=(await c.cookies()).find(v=>v.name==='crm_session')?.value;assert.ok(cookie,'CRM session required');cookies.add(cookie)
  }
  stage='independent-contexts'
  assert.equal(new Set(users).size,1,'One admin account required');assert.equal(new Set(areaIds).size,3)
  assert.equal(cookies.size,3,'Independent CRM sessions required')
  assert.deepEqual(chips[0],chips[1]);assert.deepEqual(chips[0],chips[2])
  await choose(pages[0],areaIds[1]);await choose(pages[0],areaIds[0])
  for(let i=0;i<3;i++)assert.equal(await pages[i].frameLocator('[data-testid="crm-frame"]').getByLabel('Área de negócio',{exact:true}).inputValue(),areaIds[i])
  stage='crm-logout-isolation'
  await pages[0].close()
  assert.equal((await contexts[0].request.post(base+'/crm/api/auth/logout',{headers:{'x-requested-with':'crm'},data:{}})).status(),200)
  assert.equal((await contexts[0].request.get(base+'/crm/api/business-areas')).status(),401)
  for(const c of contexts.slice(1))assert.equal((await c.request.get(base+'/crm/api/business-areas')).status(),200)
  assert.equal(errors.length,0,'Browser JavaScript errors');assert.equal(blocked.length,0,'Unexpected business mutation or origin')
  console.log(JSON.stringify({passed:true,admin_account:true,independent_area_contexts:3,desktop_mobile:true,panel_sso_offers_navigation:true,shared_chips:true,logout_isolated:true,business_writes:false}))
}catch{
  failed=true;console.error('Business areas browser verification failed at '+stage+'; credentials and business data withheld')
}finally{
  for(const c of contexts){try{for(const cookie of await c.cookies())if(cookie.name==='crm_session')cookies.add(cookie.value)}catch{}}
  const cleanup=await revokeTemporarySessions(request,sessions,cookies)
  for(const c of contexts)await c.close().catch(()=>{})
  await browser.close()
  console.log(JSON.stringify({cleanup:true,...cleanup}))
  if(!cleanup.panelTokens401||!cleanup.crmCookiesRevoked)failed=true
}
if(failed)process.exitCode=1
