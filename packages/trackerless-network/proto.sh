cd "$(dirname "$0")"
mkdir -p ./generated
npx protoc --ts_out ./generated --ts_opt server_generic,generate_dependencies,long_type_number --proto_path ../.. packages/trackerless-network/protos/NetworkRpc.proto
