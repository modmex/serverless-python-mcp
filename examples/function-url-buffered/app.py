from modmex_lambda import APIGatewayHttpResolver
from server import mcp

app = APIGatewayHttpResolver()
app.include_mcp(mcp)

handler = app.handler
