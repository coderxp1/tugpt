import uuid,json,pytest,httpx
from fastapi.testclient import TestClient
from server import Store,Submission,create_app
from worker import MediaWorker
@pytest.fixture
def case(tmp_path,monkeypatch):
 token=tmp_path/'token';token.write_text('t'*48);monkeypatch.setenv('TUGPT_AI_TOKEN_FILE',str(token))
 store=Store(tmp_path/'state');client=TestClient(create_app(store,start_engine=False));client.headers['Authorization']='Bearer '+'t'*48
 return store,client,{'id':str(uuid.uuid4()),'organization_id':str(uuid.uuid4()),'prompt':'A cup'}
def test_auth(case):
 _,c,_=case;c.headers.clear();assert c.get('/health').status_code==401
def test_idempotency(case):
 _,c,b=case;assert c.post('/jobs',json=b).status_code==202;assert c.post('/jobs',json=b).status_code==202
 assert c.post('/jobs',json={**b,'prompt':'changed'}).status_code==409
def test_tenant(case):
 _,c,b=case;c.post('/jobs',json=b)
 for suffix in ('','/result'):
  assert c.get('/jobs/'+b['id']+suffix,params={'organization_id':str(uuid.uuid4())}).status_code==404
 assert c.post('/jobs/'+b['id']+'/cancel',params={'organization_id':str(uuid.uuid4())}).status_code==404
def test_quota(case):
 _,c,b=case;c.post('/jobs',json=b);assert c.post('/jobs',json={**b,'id':str(uuid.uuid4())}).status_code==429
@pytest.mark.parametrize('patch',[{'width':8192},{'seed':-1},{'width':True},{'steps':100},{'model':'arbitrary'},{'prompt':' '},{'prompt':'a'*1001}])
def test_validation(case,patch):
 _,c,b=case;assert c.post('/jobs',json={**b,**patch}).status_code==422
def test_body(case):
 _,c,_=case;assert c.post('/jobs',content=b'x'*8193).status_code==413
def test_recovery(case):
 s,c,b=case;c.post('/jobs',json=b);s.claim();s.recover();assert s.get(b['id'],b['organization_id'])['error']=='GPU_PROCESS_RESTARTED';assert s.claim() is None
 assert Store(s.root).submit(Submission(**b))['status']=='failed'
def test_cancel_race(case):
 s,c,b=case;c.post('/jobs',json=b);s.claim();s.cancel(b['id'],b['organization_id']);s.update(b['id'],status='completed');assert s.get(b['id'],b['organization_id'])['status']=='cancelled'

@pytest.fixture
def pipeline():
 job={'id':str(uuid.uuid4()),'organization_id':str(uuid.uuid4()),'kind':'image','status':'processing','prompt':'A cup','params':{},'prompt_id':None,'pgmq_msg_id':1}
 state={'enabled':True,'lease':True,'gpu_status':'completed','calls':[]}
 def db(req):
  state['calls'].append(('db',req.url.path,json.loads(req.content) if req.content and req.headers.get('content-type')=='application/json' else None))
  if req.method=='GET':return httpx.Response(200,json=[job])
  name=req.url.path.rsplit('/',1)[-1]
  if name=='is_feature_enabled':return httpx.Response(200,json=state['enabled'])
  if name=='set_media_visibility':return httpx.Response(200,json=state['lease'])
  if name=='complete_media_job':job['status']='completed'
  return httpx.Response(200,json=True)
 def gpu(req):
  state['calls'].append(('gpu',req.url.path,json.loads(req.content) if req.content else None))
  if req.url.path.endswith('/result'):return httpx.Response(200,content=b'\x89PNG\r\n\x1a\nfixture')
  if req.url.path.endswith('/cancel'):return httpx.Response(200,json={'status':'cancelled'})
  return httpx.Response(200,json={'id':job['id'],'status':state['gpu_status'],'seconds':1.5})
 worker=MediaWorker(httpx.Client(base_url='https://database.test',transport=httpx.MockTransport(db)),httpx.Client(base_url='http://127.0.0.1:18765',transport=httpx.MockTransport(gpu)))
 msg={'msg_id':1,'payload':{'mediaJobId':job['id']}}
 return worker,msg,job,state

def test_worker_upload_identity_and_order(pipeline):
 w,m,j,s=pipeline;w.process(m)
 paths=[x[1] for x in s['calls']]
 assert paths.index('/rest/v1/rpc/record_media_submission')<paths.index('/jobs')
 assert '/storage/v1/object/media/'+j['organization_id']+'/'+j['id']+'.png' in paths
 assert paths.index('/rest/v1/rpc/complete_media_job')<paths.index('/rest/v1/rpc/delete_media_job')
 assert j['status']=='completed'
def test_worker_disabled(pipeline):
 w,m,j,s=pipeline;s['enabled']=False;w.process(m)
 assert not any(x[1]=='/jobs' for x in s['calls'])
 assert any(x[1].endswith('/skip_media_job') for x in s['calls'])
def test_worker_lease_loss(pipeline):
 w,m,j,s=pipeline;s['lease']=False
 with pytest.raises(RuntimeError,match='LEASE_LOST'):w.process(m)
 assert not any('/storage/' in x[1] for x in s['calls'])
@pytest.mark.parametrize('patch',[{'kind':'video'},{'params':{'steps':100}},{'prompt_id':'foreign-provider'}])
def test_worker_unsupported(pipeline,patch):
 w,m,j,s=pipeline;j.update(patch);w.process(m)
 assert not any(x[1]=='/jobs' for x in s['calls'])
 assert any(x[1].endswith('/archive_media_failed_job') for x in s['calls'])
def test_worker_cancelled(pipeline):
 w,m,j,s=pipeline;j['status']='cancelled';w.process(m)
 assert any(x[1].endswith('/cancel') for x in s['calls'])
 assert not any('/storage/' in x[1] for x in s['calls'])
def test_worker_identity(pipeline):
 w,m,j,s=pipeline;j['pgmq_msg_id']=2
 with pytest.raises(ValueError,match='QUEUE_IDENTITY_MISMATCH'):w.process(m)
 assert not any(x[0]=='gpu' for x in s['calls'])
