from modmex_lambda import LambdaWebAdapterResolver
from server import mcp

app = LambdaWebAdapterResolver()
app.include_mcp(mcp)
handler = app.handler
