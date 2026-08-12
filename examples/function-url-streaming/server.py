from modmex_lambda.mcp import MCPServer

mcp = MCPServer(name="example", version="0.1.0")

@mcp.tool()
def echo(message: str) -> dict[str, str]:
    return {"message": message}
