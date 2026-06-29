require "test_helper"

module Api
  module V1
    class ProxyBaselinesControllerTest < ActionDispatch::IntegrationTest
      ACME_TOKEN = "iak_acme-ci-token".freeze

      def auth_headers(token = ACME_TOKEN)
        { "Authorization" => "Bearer #{token}", "Content-Type" => "application/json" }
      end

      def json_body
        JSON.parse(response.body)
      end

      test "PUT upserts a baseline with arbitrary transform JSON" do
        body = {
          data: {
            namespace: "acme",
            name: "Infra proxy baseline",
            labels: { "managed-by" => "centaur" },
            transforms: [
              { name: "header_allowlist", config: { headers: [ "authorization", "/^x-openai-.*$/" ] } }
            ]
          }
        }

        assert_difference -> { ProxyBaseline.count }, 1 do
          put api_v1_proxy_baseline_url(id: "infra"), params: body.to_json, headers: auth_headers
        end
        assert_response :created

        data = json_body.fetch("data")
        assert_match(/\Apbl_/, data.fetch("id"))
        assert_equal "infra", data.fetch("foreign_id")
        assert_equal "header_allowlist", data.dig("transforms", 0, "name")
        assert_equal [ "authorization", "/^x-openai-.*$/" ], data.dig("transforms", 0, "config", "headers")
      end

      test "lookup finds a baseline by namespace and foreign_id" do
        baseline = ProxyBaseline.create!(
          namespace: "acme", foreign_id: "infra", name: "Infra",
          transforms: [ { "name" => "header_allowlist", "config" => { "headers" => [ "authorization" ] } } ],
          created_by: users(:acme_admin)
        )

        get lookup_api_v1_proxy_baselines_url(namespace: "acme", foreign_id: "infra"),
            headers: auth_headers
        assert_response :ok
        assert_equal baseline.oid, json_body.dig("data", "id")
      end
    end
  end
end
