from modmex_lambda import APIGatewayRestResolver
from server import mcp

app = APIGatewayRestResolver()
app.include_mcp(mcp)
handler = app.handler
