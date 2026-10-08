from contextlib import nullcontext
from threading import BoundedSemaphore
import base64
import json
import os
import uvicorn
from starlette.responses import JSONResponse
from starlette.routing import Route
from pathlib import Path
from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, ImageContent, TextContent
from .service import KnowledgeService
from .store import BusinessError


def create_server(service):
    mcp = MCPServer('ScholarPi Knowledge', version='0.1.0', instructions='Read versioned evidence. Notes are personal interpretations; graph edges describe provenance only.')

    read_gate = BoundedSemaphore(3)
    write_ops = {'save_note', 'create_card', 'review_card', 'edit_card', 'delete_card', 'delete_note', 'ingest', 'session_put', 'run_put', 'vision_put', 'vision_page', 'merge_concept', 'link_objects', 'index_retry'}

    def result(operation, args, image=False):
        try:
            with nullcontext() if operation in write_ops else read_gate:
                value = service.operation(operation, args)
            blocks = []
            if image:
                image_path = value.pop('path')
                blocks.append(ImageContent(data=base64.b64encode(Path(image_path).read_bytes()).decode('ascii'), mime_type='image/png'))
            blocks.append(TextContent(text=json.dumps(value, ensure_ascii=False)))
            return CallToolResult(content=blocks, structured_content=value)
        except BusinessError as exc:
            value = dict(code=exc.code, message=str(exc), error=dict(code=exc.code, message=str(exc)))
        except (KeyError, TypeError, ValueError):
            value = dict(code='INVALID_ARGUMENT', message='Missing or invalid operation parameters', error=dict(code='INVALID_ARGUMENT', message='Missing or invalid operation parameters'))
        except Exception:
            value = dict(error=dict(code='RETRYABLE_FAILURE', message='Operation failed; consult local service diagnostics'))
        return CallToolResult(content=[TextContent(text=json.dumps(value))], structured_content=value, is_error=True)

    @mcp.tool(description='Read paper metadata, actual parsing coverage and structural document tree.')
    def get_paper_overview(paper_id: str, revision_id: str | None = None) -> CallToolResult:
        return result('paper_overview', locals())

    @mcp.tool(description='Read complete extracted text or an explicit physical page range. Never silently truncates.')
    def read_paper_text(paper_id: str, revision_id: str | None = None, start_page: int = 1, end_page: int | None = None) -> CallToolResult:
        args = {k: v for k, v in locals().items() if v is not None}
        return result('read_paper_text', args)

    @mcp.tool(description='Read the original page image with versioned source coordinates. bbox is normalized rotated-page coordinates.')
    def read_page_image(paper_id: str, revision_id: str, page: int, bbox: list[float] | None = None) -> CallToolResult:
        return result('get_page', locals(), image=True)

    @mcp.tool(description='Search papers, personal notes and explanation cards using FTS5 and available dense embeddings. Card SourceRefs identify personal snapshots, not their creating paper; original provenance is separate.')
    def search_knowledge(query: str, object_types: list[str] | None = None, limit: int = 6, use_graph: bool = True) -> CallToolResult:
        return result('search_knowledge', locals())

    @mcp.tool(description='Resolve an exact original source and its revision; deleted sources retain honest availability state.')
    def get_source(source_id: str, revision_id: str | None = None) -> CallToolResult:
        return result('get_source', locals())

    @mcp.tool(description='Expand only sourced concept-occurrence and citation edges, bounded to two hops and ten objects.')
    def query_source_graph(object_id: str | None = None, concept: str | None = None, max_hops: int = 2, limit: int = 10) -> CallToolResult:
        return result('graph', locals())

    @mcp.tool(description='Save a personal note atomically with FTS/concept updates. Existing notes require their exact revision ID.')
    def save_note(title: str, markdown: str, idempotency_key: str, note_id: str | None = None, expected_revision: str | None = None, paper_id: str | None = None, content: dict | None = None, source_refs: list[dict] | None = None, keywords: list[str] | None = None) -> CallToolResult:
        return result('save_note', {k: v for k, v in locals().items() if v is not None})

    @mcp.tool(description='Create an immutable explanation snapshot; future note edits never rewrite its front or back.')
    def create_card(front: str, back: str, origin: str, idempotency_key: str, source_ref: dict | None = None, keyword: str | None = None) -> CallToolResult:
        return result('create_card', locals())

    @mcp.tool(description='INTERNAL application administration bridge. Not exposed to the reading Agent.')
    def app_operation(operation: str, args: dict) -> CallToolResult:
        return result(operation, args)

    # Explicit CallToolResult preserves image/error channels. Supply schemas as
    # this return type intentionally bypasses automatic data-model inference.
    schemas = {
        'get_paper_overview': {'paper': {'type': 'object'}, 'sourceRefs': {'type': 'array', 'items': {'type': 'object'}}},
        'read_paper_text': {'text': {'type': 'string'}, 'sourceRefs': {'type': 'array', 'items': {'type': 'object'}}, 'complete': {'type': 'boolean'}, 'coverage': {'type': 'object'}},
        'read_page_image': {'sourceRef': {'type': 'object'}, 'mimeType': {'type': 'string'}},
        'search_knowledge': {'evidence': {'type': 'array', 'items': {'type': 'object'}}, 'indexStatus': {'type': 'object'}},
        'get_source': {'sourceRef': {'type': 'object'}, 'text': {'type': 'string'}, 'available': {'type': 'boolean'}, 'sourceStatus': {'type': 'string'}},
        'query_source_graph': {'nodes': {'type': 'array', 'items': {'type': 'object'}}, 'edges': {'type': 'array', 'items': {'type': 'object'}}},
        'save_note': {'noteId': {'type': 'string'}, 'revisionId': {'type': 'string'}, 'markdown': {'type': 'string'}},
        'create_card': {'cardId': {'type': 'string'}, 'front': {'type': 'string'}, 'back': {'type': 'string'}, 'revision': {'type': 'integer'}},
    }
    source_schema = {'type': 'object', 'properties': {'sourceId': {'type': 'string'}, 'kind': {'enum': ['paper', 'note', 'card']}, 'objectId': {'type': 'string'}, 'revisionId': {'type': 'string'}, 'page': {'type': 'integer', 'minimum': 1}, 'bbox': {'type': 'array', 'items': {'type': 'number', 'minimum': 0, 'maximum': 1}, 'minItems': 4, 'maxItems': 4}, 'blockId': {'type': 'string'}, 'quote': {'type': 'string'}}, 'required': ['sourceId', 'kind', 'objectId', 'revisionId'], 'additionalProperties': False}
    for properties in schemas.values():
        if 'sourceRef' in properties:
            properties['sourceRef'] = source_schema
        if 'sourceRefs' in properties:
            properties['sourceRefs']['items'] = source_schema
    schemas['query_source_graph']['nodes']['items'] = {'type': 'object', 'properties': {'id': {'type': 'string'}, 'label': {'type': 'string'}, 'kind': {'type': 'string'}, 'sourceRef': source_schema, 'originSourceRef': source_schema}, 'required': ['id', 'label', 'kind']}
    schemas['query_source_graph']['edges']['items'] = {'type': 'object', 'properties': {'id': {'type': 'string'}, 'source': {'type': 'string'}, 'target': {'type': 'string'}, 'type': {'type': 'string'}, 'sourceRef': source_schema, 'originSourceRef': source_schema}, 'required': ['id', 'source', 'target', 'type', 'sourceRef']}
    schemas['search_knowledge']['evidence']['items'] = {'type': 'object', 'properties': {'text': {'type': 'string'}, 'sourceRef': source_schema, 'originSourceRef': source_schema, 'origin': {'type': 'string'}, 'contentCategory': {'type': 'string'}, 'score': {'type': 'number'}, 'lexicalRank': {'type': 'integer'}, 'denseRank': {'type': 'integer'}, 'path': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['text', 'sourceRef']}
    for name, properties in schemas.items():
        mcp._tool_manager._tools[name].fn_metadata.output_schema = {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': True}
    return mcp


def main():
    service = KnowledgeService()
    server = create_server(service)
    port = int(os.environ.get('SCHOLARPI_MCP_PORT', '7332'))
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=[f'127.0.0.1:{port}', f'localhost:{port}'], allowed_origins=[])
    try:
        app = server.streamable_http_app(streamable_http_path='/mcp', json_response=True, stateless_http=False, transport_security=security)
        async def health(request):
            if request.headers.get('host') not in (f'127.0.0.1:{port}', f'localhost:{port}') or request.headers.get('origin'):
                return JSONResponse({'error': 'Forbidden'}, status_code=403)
            return JSONResponse(service.operation('health', {}))
        app.routes.append(Route('/health', health))
        uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
    finally:
        service.close()


if __name__ == '__main__':
    main()
