import { describe,it,expect,vi,beforeEach } from 'vitest'
import type { CommandCodeClient } from '../server/lib/commandcode'
const state=vi.hoisted(()=>({saved:null as string|null,intent:null as null|{key_name:string;state:string;orphan_key_id:string|null;replacement_count:number}}))
vi.mock('../server/lib/db',()=>{
  const query:any=async(strings:TemplateStringsArray,...values:any[])=>{
    const sql=strings.join('?')
    if(sql.includes('SELECT api_key_ciphertext'))return [{api_key_ciphertext:state.saved}]
    if(sql.includes('INSERT INTO key_creation_intents')){state.intent??={key_name:values[1],state:'prepared',orphan_key_id:null,replacement_count:0};return []}
    if(sql.includes('SELECT * FROM key_creation_intents'))return [state.intent]
    if(sql.includes('UPDATE managed_accounts SET api_key_ciphertext')){state.saved=values[0];return []}
    if(sql.includes('UPDATE key_creation_intents')) {
      const status=sql.match(/SET state='([^']+)'/)?.[1]
      if(status&&state.intent)state.intent.state=status
      if(sql.includes('orphan_key_id=?')&&state.intent)state.intent.orphan_key_id=values[0]
      if(sql.includes('replacement_count=replacement_count+1')&&state.intent)state.intent.replacement_count++
      return [{account_id:'account-id'}]
    }
    return []
  }
  query.begin=async(fn:any)=>fn(query)
  return {getDb:()=>query}
})
vi.mock('../server/lib/crypto',()=>({encryptSecret:(value:string)=>`encrypted:${value}`}))
import { ensureDedicatedKey } from '../worker/keys'
describe('dedicated API key crash recovery',()=>{
  beforeEach(()=>{state.saved=null;state.intent=null})
  it('recovers only its own confirmed orphan before one replacement and reuses the saved key',async()=>{
    let keys:{id:string;name:string}[]=[]
    const listKeys=vi.fn(async()=>[...keys])
    const createKey=vi.fn().mockImplementationOnce(async(_cookie,name)=>{keys.push({id:'orphan',name});throw new Error('response lost')}).mockImplementationOnce(async(_cookie,name)=>{keys.push({id:'replacement',name});return {id:null,apiKey:'fake-secret-key'}})
    const deleteKey=vi.fn(async(_cookie,id)=>{keys=keys.filter(k=>k.id!==id)})
    const client={listKeys,createKey,deleteKey} as unknown as CommandCodeClient
    await expect(ensureDedicatedKey('account-id','fake-cookie',client)).rejects.toThrow('response lost')
    expect(state.intent?.state).toBe('creating')
    await ensureDedicatedKey('account-id','fake-cookie',client)
    await ensureDedicatedKey('account-id','fake-cookie',client)
    expect(createKey).toHaveBeenCalledTimes(2);expect(deleteKey).toHaveBeenCalledExactlyOnceWith('fake-cookie','orphan')
    expect(keys).toEqual([{id:'replacement',name:'ccm-account-id'}]);expect(state.saved).toBe('encrypted:fake-secret-key')
  })
  it('never repeats an ambiguous creation if no matching upstream key can be confirmed',async()=>{
    const createKey=vi.fn(async()=>{throw new Error('connection lost')})
    const client={listKeys:vi.fn(async()=>[]),createKey,deleteKey:vi.fn()} as unknown as CommandCodeClient
    await expect(ensureDedicatedKey('account-id','fake-cookie',client)).rejects.toThrow('connection lost')
    await expect(ensureDedicatedKey('account-id','fake-cookie',client)).rejects.toThrow('KEY_CREATION_UNCERTAIN')
    expect(createKey).toHaveBeenCalledTimes(1)
  })
  it('does not revoke or replace a pre-existing name collision without a creation intent',async()=>{
    const client={listKeys:vi.fn(async()=>[{id:'existing',name:'ccm-account-id'}]),createKey:vi.fn(),deleteKey:vi.fn()} as unknown as CommandCodeClient
    await expect(ensureDedicatedKey('account-id','fake-cookie',client)).rejects.toThrow('KEY_NAME_CONFLICT')
    expect(client.deleteKey).not.toHaveBeenCalled();expect(client.createKey).not.toHaveBeenCalled()
  })
})