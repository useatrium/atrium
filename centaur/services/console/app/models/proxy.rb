class Proxy < ApplicationRecord
  oid_prefix "prx"

  TOKEN_PREFIX = "iprx_".freeze
  TOKEN_FORMAT = /\Aiprx_[0-9a-f]{64}\z/

  attr_readonly :bearer_token_hash
  attr_accessor :token

  # Optional: a proxy may boot unassigned and have a principal assigned or
  # swapped later. principal_id is mutable so the assignment can change.
  belongs_to :principal, optional: true

  validates :name, presence: true
  validates :bearer_token_hash, presence: true, uniqueness: true
  validate :token_matches_format, on: :create

  before_validation :issue_token, on: :create
  before_save :stamp_principal_assignment, if: :will_save_change_to_principal_id?

  # Whether the proxy currently carries a principal (and therefore any authority).
  def assigned?
    principal_id.present?
  end

  # "assigned" or "unassigned"; surfaced to operators and to the proxy on sync.
  def status
    assigned? ? "assigned" : "unassigned"
  end

  def self.find_by_token(plaintext)
    return nil if plaintext.blank?
    find_by(bearer_token_hash: hash_token(plaintext))
  end

  def self.hash_token(plaintext)
    Digest::SHA256.hexdigest(plaintext)
  end

  # The config this proxy delivers, in the iron-proxy sync shape. The assembly
  # lives on Principal (it is a function of effective grants); an unassigned
  # proxy carries no authority and resolves to the empty config. Live secret
  # values are kept inline here because the proxy needs them to resolve.
  def sync_config
    config = principal&.effective_config(redact_secrets: false)
    return Principal::EMPTY_CONFIG unless config

    self.class.merge_proxy_policy(config, namespace: principal.namespace)
  end

  def sync_config_snapshot
    config = if principal
      self.class.merge_proxy_policy(PrincipalSyncConfigSnapshot.fetch_for(principal).payload,
                                    namespace: principal.namespace)
    else
      Principal::EMPTY_CONFIG
    end
    { config_hash: config_hash_for(config), config: config }
  end

  # Opaque, deterministic fingerprint of the delivered config. The proxy treats
  # this as an ETag: it echoes its current hash on each sync and only re-applies
  # config when the hash changes.
  def config_hash
    # The principal identity and assignment time are folded in so that any
    # assignment change forces a refresh, even a swap between principals whose
    # effective secrets happen to be identical (or an unassign to empty).
    config_hash_for(sync_config)
  end

  def config_hash_for(config)
    payload = config.merge(
      "principal" => principal&.oid,
      "principal_assigned_at" => principal_assigned_at&.utc&.iso8601
    )
    "sha256:#{Digest::SHA256.hexdigest(self.class.canonical_json(payload))}"
  end

  # Deep key-sorted JSON so the hash is stable regardless of Hash insertion or
  # jsonb column ordering.
  def self.canonical_json(value)
    JSON.generate(canonicalize(value))
  end

  def self.canonicalize(value)
    case value
    when Hash
      value.sort_by { |k, _| k.to_s }.to_h.transform_values { |v| canonicalize(v) }
    when Array
      value.map { |v| canonicalize(v) }
    else
      value
    end
  end

  def self.merge_proxy_policy(config, namespace:)
    baseline = ProxyBaseline.effective_for(namespace)
    credential_transforms = Array(config["transforms"])
    baseline_transforms = Array(baseline["transforms"])

    allowlist_domains, other_baseline_transforms = split_allowlist_transforms(baseline_transforms)
    allowlist_domains += domains_from_rules(config)
    allowlist = allowlist_domains.uniq.sort

    transforms = []
    transforms << { "name" => "allowlist", "config" => { "domains" => allowlist } } if allowlist.any?
    transforms += other_baseline_transforms
    transforms += credential_transforms

    {
      "secrets" => Array(config["secrets"]),
      "transforms" => transforms,
      "postgres" => Array(config["postgres"])
    }
  end

  def self.split_allowlist_transforms(transforms)
    domains = []
    others = []
    transforms.each do |transform|
      transform = normalize_json_hash(transform)
      if transform["name"] == "allowlist"
        domains += Array(transform.dig("config", "domains")).map(&:to_s).reject(&:blank?)
      else
        others << transform
      end
    end
    [ domains, others ]
  end

  def self.domains_from_rules(value)
    hosts_from_rule_arrays(normalize_json_hash(value)).uniq
  end

  def self.hosts_from_rule_arrays(value)
    case value
    when Hash
      hosts = []
      rules = value["rules"]
      if rules.is_a?(Array)
        hosts += rules.filter_map do |rule|
          rule = normalize_json_hash(rule)
          rule["host"].to_s if rule["host"].present?
        end
      end
      hosts + value.values.flat_map { |v| hosts_from_rule_arrays(v) }
    when Array
      value.flat_map { |v| hosts_from_rule_arrays(v) }
    else
      []
    end
  end

  def self.normalize_json_hash(value)
    case value
    when ActionController::Parameters
      normalize_json_hash(value.to_unsafe_h)
    when Hash
      value.transform_keys(&:to_s).transform_values { |v| normalize_json_hash(v) }
    when Array
      value.map { |v| normalize_json_hash(v) }
    else
      value
    end
  end

  private

  # Stamp (or clear) the assignment time whenever principal_id changes, so the
  # column always reflects the current assignment.
  def stamp_principal_assignment
    self.principal_assigned_at = principal_id ? Time.current : nil
  end

  def issue_token
    return if bearer_token_hash.present?
    self.token = "#{TOKEN_PREFIX}#{SecureRandom.hex(32)}"
    self.bearer_token_hash = self.class.hash_token(token)
  end

  def token_matches_format
    return if token.blank?
    return if token.match?(TOKEN_FORMAT)
    errors.add(:token, "must match #{TOKEN_FORMAT.inspect} (iprx_ + 32-byte lowercase hex)")
  end
end
