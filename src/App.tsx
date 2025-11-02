import { useEffect, useState } from 'react'
import { supabase, type Item } from './lib/supabase'

function getSessionId(): string {
  let sessionId = localStorage.getItem('voting_session_id')
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    localStorage.setItem('voting_session_id', sessionId)
  }
  return sessionId
}

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [userVotes, setUserVotes] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const sessionId = getSessionId()

  useEffect(() => {
    fetchItems()
    fetchUserVotes()

    // Subscribe to real-time updates
    const channel = supabase
      .channel('items-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        () => {
          fetchItems()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function fetchItems() {
    const { data, error } = await supabase
      .from('items')
      .select('*')
      .order('id', { ascending: true })

    if (error) {
      console.error('Error fetching items:', error)
    } else {
      setItems(data || [])
    }
    setLoading(false)
  }

  async function fetchUserVotes() {
    const { data, error } = await supabase
      .from('likes')
      .select('item_id')
      .eq('session_id', sessionId)

    if (error) {
      console.error('Error fetching user votes:', error)
    } else {
      setUserVotes(new Set(data?.map((like: { item_id: number }) => like.item_id) || []))
    }
  }

  async function toggleVote(itemId: number) {
    const hasVoted = userVotes.has(itemId)

    if (hasVoted) {
      // Remove vote
      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('item_id', itemId)
        .eq('session_id', sessionId)

      if (error) {
        console.error('Error removing vote:', error)
        return
      }

      // Update local state
      setUserVotes(prev => {
        const newSet = new Set(prev)
        newSet.delete(itemId)
        return newSet
      })

      // Optimistically update likes count
      setItems(prev =>
        prev.map(item =>
          item.id === itemId
            ? { ...item, likes_count: item.likes_count - 1 }
            : item
        )
      )
    } else {
      // Add vote
      const { error } = await supabase
        .from('likes')
        .insert({ item_id: itemId, session_id: sessionId })

      if (error) {
        console.error('Error adding vote:', error)
        return
      }

      // Update local state
      setUserVotes(prev => new Set(prev).add(itemId))

      // Optimistically update likes count
      setItems(prev =>
        prev.map(item =>
          item.id === itemId
            ? { ...item, likes_count: item.likes_count + 1 }
            : item
        )
      )
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400">
        <div className="text-white text-2xl font-semibold">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">
            50 Things I Know
          </h1>
          <p className="text-white text-lg max-w-2xl mx-auto">
            Vote for the things you find resonant. You can vote for as many items as you want.
            Click the heart to toggle your vote!
          </p>
        </div>

        <div className="space-y-4">
          {items.map((item) => {
            const hasVoted = userVotes.has(item.id)
            return (
              <div
                key={item.id}
                onClick={() => toggleVote(item.id)}
                className="bg-white rounded-lg shadow-lg p-6 cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="text-gray-800 text-lg leading-relaxed">
                      {item.text}
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-2 min-w-[60px]">
                    <button
                      className="text-3xl transition-transform duration-200 hover:scale-110"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleVote(item.id)
                      }}
                    >
                      {hasVoted ? '❤️' : '🤍'}
                    </button>
                    <span className="text-gray-600 font-semibold text-sm">
                      {item.likes_count}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-12 text-center">
          <p className="text-white text-sm">
            You've voted for {userVotes.size} item{userVotes.size !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
