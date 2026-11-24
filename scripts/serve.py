"""Local preview with the MIME types required by browser WebAssembly modules."""
import argparse
import os
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn


class Handler(SimpleHTTPRequestHandler):
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map,
                          **{'.wasm': 'application/wasm', '.js': 'text/javascript',
                             '.mjs': 'text/javascript', '.glb': 'model/gltf-binary'})


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--directory', default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    os.chdir(args.directory)
    print('Serving http://{}:{}/'.format(args.bind, args.port), flush=True)
    Server((args.bind, args.port), Handler).serve_forever()
