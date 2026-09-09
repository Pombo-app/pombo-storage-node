cd "$(dirname "$0")"
mkdir -p ./generated
npx protoc --ts_out ./generated --ts_opt  server_generic,generate_dependencies --proto_path protos protos/ProtoRpc.proto
