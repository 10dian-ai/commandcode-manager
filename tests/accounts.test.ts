import { describe,it,expect,vi } from 'vitest'
import { CommandCodeClient,buildSnapshot,classifyUpstreamError } from '../server/lib/commandcode'
import { parseCookieText,SESSION_COOKIE } from '../server/lib/account-import'
const cookie=`${SESSION_COOKIE}=test-session-only-not-real-123456`
const session={session:{id:'session-test'},user:{id:'user-test',name:'Test User',email:'test@example.invalid'}}
const credits={success:true,data:{credits:{monthlyCredits:10,purchasedCredits:0},windowLimits:{limited:true,exceeded:null,fiveHour:{used:0,cap:3,exceeded:false,resetAt:0},weekly:{used:0,cap:6,exceeded:false,resetAt:0}}}}
const subscriptions={success:true,data:{planId:'individual-go',status:'active',currentPeriodStart:'2026-09-05T07:35:12Z',currentPeriodEnd:'2026-10-05T07:35:12Z',cancelAtPeriodEnd:false}}
const usage={success:true,data:{totalCost:0.5,totalTokens:100,periodBasis:'billing-period'}}
describe('account credential parsing',()=>{
  it('preserves exact values, handles full headers and deduplicates without decoding',()=>{
    const value='test%2Fsession%3D.1234567890'
    const result=parseCookieText(`${value}\nCookie: other=ok; ${SESSION_COOKIE}=${value}; test=ignored\n\nshort\n`)
    expect(result.entries).toEqual([{line:1,cookie:`${SESSION_COOKIE}=${value}`}])
    expect(result.duplicates).toBe(1);expect(result.errors).toEqual([{line:4,message:'Token 格式无效'}])
    expect(JSON.stringify(result.errors)).not.toContain(value)
  })
  it('rejects a duplicate target cookie, line controls and another session cookie name',()=>{
    expect(parseCookieText(`${cookie};${cookie}\n__Secure-other.session_token=abcdef123456789012345\ninvalid\u0000longlonglongtoken`).entries).toEqual([])
  })
})
describe('official account request contract',()=>{
  it('uses the verified routes and preserves real limits and independent usage',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(session)).mockResolvedValueOnce(Response.json(credits)).mockResolvedValueOnce(Response.json(subscriptions)).mockResolvedValueOnce(Response.json(usage))
    const gate=vi.fn(async()=>{})
    const client=new CommandCodeClient({fetch:fetcher,beforeRequest:gate})
    const snapshot=await client.snapshot(cookie)
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['https://api.commandcode.ai/auth/get-session','https://api.commandcode.ai/internal/billing/credits','https://api.commandcode.ai/internal/billing/subscriptions','https://api.commandcode.ai/internal/usage/summary'])
    for(const [,init] of fetcher.mock.calls){expect(init?.method).toBe('GET');expect((init?.headers as Record<string,string>).cookie).toBe(cookie);expect(init?.redirect).toBe('error')}
    expect(gate).toHaveBeenCalledTimes(4)
    expect(snapshot.credits.monthlyCredits).toBe(10)
    expect(snapshot.usage?.totalCost).toBe(0.5)
    expect(snapshot.windowLimits?.limited).toBe(true)
    expect(snapshot.windowLimits?.fiveHour?.resetAt).toBe(0)
    expect(snapshot.subscription.cancelAtPeriodEnd).toBe(false)
  })
  it('does not reinterpret model permission errors as expired credentials',()=>{
    expect(classifyUpstreamError(401,{error:{code:'MODEL_NOT_IN_PLAN'}}).credentialExpired).toBe(false)
    expect(classifyUpstreamError(403,{error:'upgrade_required'}).credentialExpired).toBe(false)
    expect(classifyUpstreamError(401,{error:{code:'INVALID_SESSION'}}).credentialExpired).toBe(true)
    const error=classifyUpstreamError(500,{message:cookie,error:{message:cookie}})
    expect(error.message).not.toContain(cookie)
  })
  it('rejects an expired session and malformed snapshot instead of fabricating zeros',async()=>{
    const client=new CommandCodeClient({fetch:vi.fn<typeof fetch>().mockResolvedValue(Response.json(null))})
    await expect(client.snapshot(cookie)).rejects.toMatchObject({credentialExpired:true})
    expect(()=>buildSnapshot(session,{data:{}},subscriptions,usage)).toThrow('INVALID_CREDITS_RESPONSE')
    expect(()=>buildSnapshot(session,credits,{data:{subscription:subscriptions.data}},usage)).toThrow('INVALID_SUBSCRIPTION_RESPONSE')
  })
  it('uses POST for key list, creation and deletion and leaves model catalogue anonymous',async()=>{
    const fetcher=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{id:'key-id',name:'ccm-test'}]))
      .mockResolvedValueOnce(Response.json({apiKey:'fake-key-never-real-123456789'}))
      .mockResolvedValueOnce(Response.json({success:true}))
      .mockResolvedValueOnce(Response.json({object:'list',data:[{id:'test/model',owned_by:'test'}]}))
    const client=new CommandCodeClient({fetch:fetcher})
    expect(await client.listKeys(cookie)).toEqual([{id:'key-id',name:'ccm-test'}])
    expect((await client.createKey(cookie,'ccm-test')).apiKey).toBe('fake-key-never-real-123456789')
    await client.deleteKey(cookie,'key-id');expect((await client.catalog())[0]?.id).toBe('test/model')
    expect(fetcher.mock.calls.slice(0,3).map(c=>JSON.parse(c[1]?.body as string))).toEqual([{orgId:null},{orgId:null,name:'ccm-test',description:'Dedicated Command Code Manager key'},{orgId:null,apiKeyId:'key-id'}])
    expect(fetcher.mock.calls[3]?.[0]).toBe('https://api.commandcode.ai/provider/v1/models')
    expect((fetcher.mock.calls[3]?.[1]?.headers as Record<string,string>).cookie).toBeUndefined()
  })
})