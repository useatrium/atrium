module Api
  module V1
    class ProxyBaselinesController < Api::BaseController
      def index
        records, meta = paginated_label_search(ProxyBaseline.all)
        render json: { data: records.map { |r| record_payload(r) }, meta: meta }
      end

      def show
        baseline = ProxyBaseline.find_by_oid!(params[:id])
        render json: { data: record_payload(baseline) }
      end

      def lookup
        render json: { data: record_payload(find_by_foreign_id!(ProxyBaseline)) }
      end

      def create
        baseline = ProxyBaseline.new(namespace: upsert_namespace, foreign_id: data_params[:foreign_id],
                                     created_by: current_user)
        assign_payload(baseline)
        baseline.save!
        render status: :created, json: { data: record_payload(baseline) }
      rescue ActiveRecord::RecordInvalid => e
        render_validation_error(e.record)
      end

      def update
        baseline = resolve_for_upsert(ProxyBaseline)
        was_new = baseline.new_record?
        baseline.created_by ||= current_user
        assign_payload(baseline)
        baseline.save!
        render status: (was_new ? :created : :ok), json: { data: record_payload(baseline) }
      rescue ActiveRecord::RecordInvalid => e
        render_validation_error(e.record)
      end

      def destroy
        baseline = ProxyBaseline.find_by_oid!(params[:id])
        baseline.destroy!
        head :no_content
      end

      private

      def assign_payload(baseline)
        payload = data_params.to_unsafe_h
        baseline.name = payload["name"] if payload.key?("name")
        baseline.labels = payload["labels"] if payload.key?("labels")
        baseline.transforms = payload["transforms"] if payload.key?("transforms")
      end

      def record_payload(baseline)
        {
          id: baseline.oid,
          namespace: baseline.namespace,
          foreign_id: baseline.foreign_id,
          name: baseline.name,
          labels: baseline.labels,
          transforms: baseline.transforms,
          created_at: baseline.created_at,
          updated_at: baseline.updated_at
        }
      end
    end
  end
end
