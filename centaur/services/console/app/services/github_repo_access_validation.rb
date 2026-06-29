require "net/http"
require "uri"

class GithubRepoAccessValidation
  class ValidationError < StandardError; end
  class CredentialUnavailable < ValidationError; end
  class RetryableFailure < ValidationError; end

  class << self
    attr_accessor :github_api_http
  end

  def self.call(access_token:, repos:)
    new(access_token: access_token, repos: repos).call
  end

  def initialize(access_token:, repos:)
    @access_token = access_token
    @repos = Array(repos)
  end

  def call
    raise CredentialUnavailable, "credential has no live access token" if @access_token.blank?

    inaccessible = []
    @repos.each do |repo|
      parsed = parse_repo(repo)
      if parsed.nil?
        inaccessible << repo.to_s
        next
      end
      status = repo_status(parsed.fetch(:owner), parsed.fetch(:name))
      if status.between?(200, 299)
        next
      elsif status == 403 || status == 404
        inaccessible << "#{parsed.fetch(:owner)}/#{parsed.fetch(:name)}"
      else
        raise RetryableFailure, "github repo lookup failed with status #{status}"
      end
    end
    { inaccessible: inaccessible }
  end

  private

  def parse_repo(repo)
    raw = repo.to_s.strip
    parts = raw.split("/")
    return nil unless parts.length == 2 && parts[0].present? && parts[1].present?

    { owner: parts[0], name: parts[1] }
  end

  def repo_status(owner, name)
    url = "https://api.github.com/repos/#{URI.encode_www_form_component(owner)}/#{URI.encode_www_form_component(name)}"
    if self.class.github_api_http
      return Integer(self.class.github_api_http.call(url: url, access_token: @access_token))
    end

    uri = URI.parse(url)
    req = Net::HTTP::Get.new(uri)
    req["Accept"] = "application/vnd.github+json"
    req["Authorization"] = "Bearer #{@access_token}"
    req["X-GitHub-Api-Version"] = "2022-11-28"
    req["User-Agent"] = "centaur-console"

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = 5
    http.read_timeout = 5
    http.request(req).code.to_i
  rescue RetryableFailure
    raise
  rescue StandardError => e
    raise RetryableFailure, e.class.name
  end
end
