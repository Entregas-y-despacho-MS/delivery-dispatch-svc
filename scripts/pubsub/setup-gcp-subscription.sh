#!/usr/bin/env bash
set -euo pipefail

: "${PUBSUB_PROJECT_ID:?Set PUBSUB_PROJECT_ID to the Google Cloud project ID.}"
: "${PUBSUB_INBOUND_TOPIC:?Set PUBSUB_INBOUND_TOPIC to the existing shared topic ID.}"
: "${PUBSUB_INBOUND_SUBSCRIPTION:?Set PUBSUB_INBOUND_SUBSCRIPTION to the subscription ID for this backend.}"

if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud CLI is required to provision the Pub/Sub subscription." >&2
    exit 1
fi

project="$PUBSUB_PROJECT_ID"
topic="$PUBSUB_INBOUND_TOPIC"
subscription="$PUBSUB_INBOUND_SUBSCRIPTION"
expected_topic="projects/${project}/topics/${topic}"
broker_dead_letter="${topic}.delivery-failures"

# The input topic belongs to the publisher and must already exist.
gcloud pubsub topics describe "$topic" --project="$project" >/dev/null
if ! gcloud pubsub topics describe "$broker_dead_letter" --project="$project" >/dev/null 2>&1; then
    gcloud pubsub topics create "$broker_dead_letter" --project="$project"
fi

if gcloud pubsub subscriptions describe "$subscription" --project="$project" >/dev/null 2>&1; then
    actual_topic="$(gcloud pubsub subscriptions describe "$subscription" --project="$project" --format='value(topic)')"
    if [[ "$actual_topic" != "$expected_topic" ]]; then
        echo "Subscription $subscription is attached to $actual_topic, expected $expected_topic." >&2
        exit 1
    fi
    echo "Subscription $subscription already exists on $expected_topic."
else
    gcloud pubsub subscriptions create "$subscription" \
        --project="$project" \
        --topic="$topic" \
        --ack-deadline=30 \
        --dead-letter-topic="$broker_dead_letter" \
        --max-delivery-attempts=5 \
        --min-retry-delay=10s \
        --max-retry-delay=600s
fi

create_topic_if_missing() {
    local name="$1"
    if ! gcloud pubsub topics describe "$name" --project="$project" >/dev/null 2>&1; then
        gcloud pubsub topics create "$name" --project="$project"
    fi
}

# The app publishes schema rejections to each logical input topic's dead-letter topic.
create_topic_if_missing "${topic}.dead-letter"
shopt -s nullglob
for schema in contracts/messages/schemas/*.schema.json; do
    filename="${schema##*/}"
    logical_topic="${filename%.schema.json}"
    [[ "$logical_topic" == dispatch.* ]] && continue
    create_topic_if_missing "${logical_topic}.dead-letter"
done

echo "Ready. Configure the backend with this project, topic and subscription, and unset PUBSUB_EMULATOR_HOST."
echo "Grant the backend service account Pub/Sub Subscriber on $subscription and Pub/Sub Publisher on the app dead-letter topics."
echo "Grant the Pub/Sub service agent Pub/Sub Publisher on $broker_dead_letter for broker retry exhaustion."
echo "Existing subscriptions are checked but their retry/dead-letter policy is not changed by this script."
