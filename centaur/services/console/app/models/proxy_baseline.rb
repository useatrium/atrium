class ProxyBaseline < ApplicationRecord
  oid_prefix "pbl"

  include ForeignIdCollisionGuard

  attr_readonly :namespace, :foreign_id

  belongs_to :created_by, class_name: "User"

  URL_SAFE_FORMAT = /\A[A-Za-z0-9\-._~]+\z/
  URL_SAFE_MESSAGE = "must contain only URL-safe characters (A-Z, a-z, 0-9, -, ., _, ~)"

  validates :namespace, presence: true, format: { with: URL_SAFE_FORMAT, message: URL_SAFE_MESSAGE }
  validates :foreign_id, presence: true, uniqueness: { scope: :namespace },
            format: { with: URL_SAFE_FORMAT, message: URL_SAFE_MESSAGE }
  validates :name, presence: true
  validate :labels_is_a_hash
  validate :transforms_is_an_array

  def self.effective_for(namespace)
    transforms = where(namespace: namespace).order(:id).flat_map { |baseline| Array(baseline.transforms) }
    { "transforms" => transforms }
  end

  private

  def labels_is_a_hash
    errors.add(:labels, "must be a hash") unless labels.is_a?(Hash)
  end

  def transforms_is_an_array
    errors.add(:transforms, "must be an array") unless transforms.is_a?(Array)
  end
end
